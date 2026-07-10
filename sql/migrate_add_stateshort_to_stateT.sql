-- Migration: Add StateShort column to StateT
-- Run once against the production database.
-- After running, populate StateShort with abbreviated state names.
-- The API will then return stateShort in the tb-prepare response and the
-- DHIS2 Step 2 table will display the short name instead of the full name.
-- ----------------------------------------------------------------------------

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('StateT') AND name = 'StateShort'
)
BEGIN
    ALTER TABLE StateT ADD StateShort VARCHAR(20) NULL;
    PRINT 'Added StateShort column to StateT';
END
ELSE
    PRINT 'StateShort already exists — skipping.';
GO

-- After running the migration, populate StateShort for each state, e.g.:
-- UPDATE StateT SET StateShort = 'LAG' WHERE State = 'Lagos';
-- UPDATE StateT SET StateShort = 'ABJ' WHERE State = 'FCT Abuja';
-- (Leave NULL for states where you want the full name to show.)
