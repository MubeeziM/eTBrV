-- =============================================================================
--  Migration: Add TBStatusID column to PtDetailsT
--
--  Run once on the live database in SSMS.
--
--  Root cause: TBStatusID was referenced in the API MERGE statement but was
--  accidentally omitted from the original CREATE TABLE script, causing every
--  sync request to fail with a 500 "Invalid column name 'TBStatusID'" error.
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

IF NOT EXISTS (
    SELECT 1
    FROM   sys.columns
    WHERE  object_id = OBJECT_ID('PtDetailsT')
      AND  name      = 'TBStatusID'
)
BEGIN
    ALTER TABLE PtDetailsT
        ADD TBStatusID INTEGER NOT NULL
            CONSTRAINT DF_PtDetailsT_TBStatusID DEFAULT 0
            CONSTRAINT FK_PtDetailsT_TBStatus   REFERENCES TBStatusT(TBStatusID);

    PRINT 'TBStatusID column added to PtDetailsT.';
END
ELSE
BEGIN
    PRINT 'TBStatusID already exists — skipping.';
END
GO
