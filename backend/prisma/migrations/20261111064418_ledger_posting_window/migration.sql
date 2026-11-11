
-- BalanceVault: restrict ledger entries to the transaction
-- that created their LedgerTransaction header.

-- 1. Stamp every new transaction header.
CREATE OR REPLACE FUNCTION public.bv_stamp_ledger_transaction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW."postedTxid" := pg_current_xact_id()::text;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "LedgerTransaction_stamp_posting_txid"
BEFORE INSERT ON public."LedgerTransaction"
FOR EACH ROW
EXECUTE FUNCTION public.bv_stamp_ledger_transaction();

-- 2. Reject entries inserted by a different DB transaction.
CREATE OR REPLACE FUNCTION public.bv_assert_entry_in_posting_transaction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_posted varchar(20);
BEGIN
  SELECT t."postedTxid"
    INTO v_posted
    FROM public."LedgerTransaction" AS t
   WHERE t."id" = NEW."transactionId";

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'ledger transaction % does not exist or is not visible to this database transaction',
      NEW."transactionId"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_posted <> pg_current_xact_id()::text THEN
    RAISE EXCEPTION
      'ledger transaction % is already posted: entries may only be added by the database transaction that created it',
      NEW."transactionId"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "LedgerEntry_posting_window"
BEFORE INSERT ON public."LedgerEntry"
FOR EACH ROW
EXECUTE FUNCTION public.bv_assert_entry_in_posting_transaction();

-- 3. Keep both new triggers enabled in ALWAYS mode.
ALTER TABLE public."LedgerTransaction"
ENABLE ALWAYS TRIGGER "LedgerTransaction_stamp_posting_txid";

ALTER TABLE public."LedgerEntry"
ENABLE ALWAYS TRIGGER "LedgerEntry_posting_window";
