-- Run ONCE per PostgreSQL cluster, as a superuser (postgres).
-- Creates the runtime role WITHOUT a password. Set the password interactively
-- afterwards with:  \password bv_app   (never put it in a file)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bv_app') THEN
    CREATE ROLE bv_app LOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;