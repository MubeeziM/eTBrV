-- ============================================================================
-- Migration: Split CTXTotal / DapsoneTotal into Male and Female columns
-- Run once on FacilityBaselineT.
--
-- Before : CTXTotal INT, DapsoneTotal INT   (combined, sex unknown)
-- After  : CTXTotal_M INT, CTXTotal_F INT,
--           DapsoneTotal_M INT, DapsoneTotal_F INT
--
-- Existing values are copied to the *_M (Male) columns because the original
-- UI displayed the single total in the Male column of the report.
-- ============================================================================

-- Step 1: Add the four new columns
ALTER TABLE FacilityBaselineT
    ADD CTXTotal_M     INT NOT NULL CONSTRAINT DF_FBT_CTX_M     DEFAULT 0,
        CTXTotal_F     INT NOT NULL CONSTRAINT DF_FBT_CTX_F     DEFAULT 0,
        DapsoneTotal_M INT NOT NULL CONSTRAINT DF_FBT_Dapsone_M DEFAULT 0,
        DapsoneTotal_F INT NOT NULL CONSTRAINT DF_FBT_Dapsone_F DEFAULT 0;
GO

-- Step 2: Migrate existing data — old combined total was written to Male column
UPDATE FacilityBaselineT
SET    CTXTotal_M     = CTXTotal,
       DapsoneTotal_M = DapsoneTotal;
GO

-- Step 3: Drop the old single-total columns
ALTER TABLE FacilityBaselineT DROP CONSTRAINT DF_FBT_CTX;
ALTER TABLE FacilityBaselineT DROP CONSTRAINT DF_FBT_Dapsone;
ALTER TABLE FacilityBaselineT DROP COLUMN CTXTotal;
ALTER TABLE FacilityBaselineT DROP COLUMN DapsoneTotal;
GO

PRINT 'Migration migrate_add_ctx_dapsone_by_sex completed successfully.';
GO
