-- ============================================================================
-- Migrate PtFollowUpARTT.ViralLoad from varchar(30) to int
--
-- Background: ViralLoad was originally stored as free text (e.g. '<20', '1450').
-- It is now an integer (copies/ml) to support the <1000 / >=1000 reporting
-- threshold on the ART Monthly Report.
--
-- Run this script ONCE against the production SQL Server database.
-- ============================================================================

-- Step 1: Null-out any non-numeric entries (e.g. '<20', 'ND', free text).
--         TRY_CAST returns NULL for values that cannot be converted to INT,
--         so we clear those before attempting the column type change.
UPDATE PtFollowUpARTT
SET    ViralLoad = NULL
WHERE  ViralLoad IS NOT NULL
  AND  TRY_CAST(ViralLoad AS INT) IS NULL;

-- Step 2: Change the column from varchar(30) to int (nullable).
ALTER TABLE PtFollowUpARTT
    ALTER COLUMN ViralLoad INT NULL;

-- Step 3: Add a default of 0 so new rows that omit the column get 0.
ALTER TABLE PtFollowUpARTT
    ADD CONSTRAINT DF_PtFollowUpARTT_ViralLoad DEFAULT 0 FOR ViralLoad;
