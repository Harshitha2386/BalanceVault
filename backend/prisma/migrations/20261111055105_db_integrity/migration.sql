-- ============================================================================
-- BalanceVault: database integrity migration (hand-written, not generated).
-- Prisma's schema language cannot express CHECK constraints or triggers.
-- ============================================================================

-- 1. Accounts ----------------------------------------------------------------
-- CUSTOMER accounts may never go negative. SYSTEM accounts (the funding source)
-- legitimately go negative.
ALTER TABLE "Account"
  ADD CONSTRAINT "Account_customer_balance_non_negative"
  CHECK ("kind" = 'SYSTEM' OR "balanceMinor" >= 0);

-- CUSTOMER accounts must have an owner; SYSTEM accounts must not.
ALTER TABLE "Account"
  ADD CONSTRAINT "Account_owner_matches_kind"
  CHECK (("kind" = 'CUSTOMER') = ("ownerId" IS NOT NULL));

-- 2. Users -------------------------------------------------------------------
ALTER TABLE "User"
  ADD CONSTRAINT "User_email_lowercase"
  CHECK ("email" = lower("email"));

-- 3. Ledger entries ----------------------------------------------------------
ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_amount_positive"
  CHECK ("amountMinor" > 0);

-- 4. Append-only enforcement -------------------------------------------------
CREATE FUNCTION bv_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table "%" is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "LedgerEntry_append_only_row"
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION bv_reject_mutation();
CREATE TRIGGER "LedgerEntry_append_only_truncate"
  BEFORE TRUNCATE ON "LedgerEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION bv_reject_mutation();

CREATE TRIGGER "LedgerTransaction_append_only_row"
  BEFORE UPDATE OR DELETE ON "LedgerTransaction"
  FOR EACH ROW EXECUTE FUNCTION bv_reject_mutation();
CREATE TRIGGER "LedgerTransaction_append_only_truncate"
  BEFORE TRUNCATE ON "LedgerTransaction"
  FOR EACH STATEMENT EXECUTE FUNCTION bv_reject_mutation();

CREATE TRIGGER "AuditLog_append_only_row"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION bv_reject_mutation();
CREATE TRIGGER "AuditLog_append_only_truncate"
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION bv_reject_mutation();

-- 5. Double-entry balancing (checked at COMMIT) ------------------------------
CREATE FUNCTION bv_assert_ledger_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_transaction_id uuid;
  v_debits  numeric;
  v_credits numeric;
  v_entries bigint;
BEGIN
  IF TG_TABLE_NAME = 'LedgerEntry' THEN
    v_transaction_id := NEW."transactionId";
  ELSE
    v_transaction_id := NEW."id";
  END IF;

  SELECT COALESCE(SUM("amountMinor") FILTER (WHERE "direction" = 'DEBIT'), 0),
         COALESCE(SUM("amountMinor") FILTER (WHERE "direction" = 'CREDIT'), 0),
         COUNT(*)
    INTO v_debits, v_credits, v_entries
    FROM "LedgerEntry"
   WHERE "transactionId" = v_transaction_id;

  IF v_entries < 2 THEN
    RAISE EXCEPTION 'ledger transaction % needs at least 2 entries (found %)',
      v_transaction_id, v_entries
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced: debits=% credits=%',
      v_transaction_id, v_debits, v_credits
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "LedgerEntry_balanced"
  AFTER INSERT ON "LedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bv_assert_ledger_transaction_balanced();

CREATE CONSTRAINT TRIGGER "LedgerTransaction_has_entries"
  AFTER INSERT ON "LedgerTransaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bv_assert_ledger_transaction_balanced();

-- 6. Keep the triggers active even if a superuser sets
--    session_replication_role = replica -----------------------------------------
ALTER TABLE "LedgerEntry"       ENABLE ALWAYS TRIGGER "LedgerEntry_append_only_row";
ALTER TABLE "LedgerEntry"       ENABLE ALWAYS TRIGGER "LedgerEntry_append_only_truncate";
ALTER TABLE "LedgerEntry"       ENABLE ALWAYS TRIGGER "LedgerEntry_balanced";
ALTER TABLE "LedgerTransaction" ENABLE ALWAYS TRIGGER "LedgerTransaction_append_only_row";
ALTER TABLE "LedgerTransaction" ENABLE ALWAYS TRIGGER "LedgerTransaction_append_only_truncate";
ALTER TABLE "LedgerTransaction" ENABLE ALWAYS TRIGGER "LedgerTransaction_has_entries";
ALTER TABLE "AuditLog"          ENABLE ALWAYS TRIGGER "AuditLog_append_only_row";
ALTER TABLE "AuditLog"          ENABLE ALWAYS TRIGGER "AuditLog_append_only_truncate";