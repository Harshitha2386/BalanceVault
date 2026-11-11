BEGIN;

CREATE UNIQUE INDEX "OnboardingApplication_userId_active_key"
  ON public."OnboardingApplication" ("userId")
  WHERE "status" IN (
    'PENDING'::public."ApplicationStatus",
    'APPROVED'::public."ApplicationStatus"
  );

COMMIT;
