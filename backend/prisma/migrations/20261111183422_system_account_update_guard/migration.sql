BEGIN;

CREATE FUNCTION public.bv_reject_system_account_app_updates()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF OLD."kind" = 'SYSTEM'::public."AccountKind"
     AND current_user = 'bv_app' THEN
    RAISE EXCEPTION 'bv_app may not modify SYSTEM accounts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.bv_reject_system_account_app_updates() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.bv_reject_system_account_app_updates() FROM PUBLIC, bv_app;

CREATE TRIGGER "Account_reject_app_system_update"
BEFORE UPDATE ON public."Account"
FOR EACH ROW
EXECUTE FUNCTION public.bv_reject_system_account_app_updates();

ALTER TABLE public."Account"
  ENABLE ALWAYS TRIGGER "Account_reject_app_system_update";

COMMIT;
