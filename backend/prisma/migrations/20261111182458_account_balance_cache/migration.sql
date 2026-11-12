BEGIN;

CREATE FUNCTION public.bv_update_account_balance_from_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_delta bigint;
BEGIN
  CASE NEW."direction"
    WHEN 'CREDIT'::public."EntryDirection" THEN
      v_delta := NEW."amountMinor";
    WHEN 'DEBIT'::public."EntryDirection" THEN
      v_delta := -NEW."amountMinor";
    ELSE
      RAISE EXCEPTION 'unsupported ledger direction: %', NEW."direction"
        USING ERRCODE = 'check_violation';
  END CASE;

  UPDATE public."Account"
     SET "balanceMinor" = "balanceMinor" + v_delta
   WHERE "id" = NEW."accountId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'account % does not exist', NEW."accountId"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.bv_update_account_balance_from_ledger() FROM PUBLIC, bv_app;

CREATE TRIGGER "LedgerEntry_balance_cache"
AFTER INSERT ON public."LedgerEntry"
FOR EACH ROW
EXECUTE FUNCTION public.bv_update_account_balance_from_ledger();

ALTER TABLE public."LedgerEntry"
  ENABLE ALWAYS TRIGGER "LedgerEntry_balance_cache";

-- Existing ledger rows predate the cache trigger; reconcile them under the
-- same migration transaction before allowing new ledger inserts to proceed.
UPDATE public."Account" AS a
   SET "balanceMinor" = COALESCE(
     (
       SELECT sum(
         CASE e."direction"
           WHEN 'CREDIT'::public."EntryDirection" THEN e."amountMinor"
           WHEN 'DEBIT'::public."EntryDirection" THEN -e."amountMinor"
         END
       )
       FROM public."LedgerEntry" AS e
       WHERE e."accountId" = a."id"
     ),
     0
   )::bigint;

COMMIT;
