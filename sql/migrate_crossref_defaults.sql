-- =============================================================================
--  Migration: Add DEFAULT 0 to nullable INT columns in CrossRefGpUsersT
--
--  Run once on the live database.
--  Fixes existing NULL values then adds DEFAULT constraints so new rows
--  always have 0 instead of NULL for every numeric column.
-- =============================================================================

-- 1. Patch any existing NULL values to 0
UPDATE CrossRefGpUsersT SET GroupID    = 0 WHERE GroupID    IS NULL;
UPDATE CrossRefGpUsersT SET CountyID   = 0 WHERE CountyID   IS NULL;
UPDATE CrossRefGpUsersT SET StateID    = 0 WHERE StateID    IS NULL;
UPDATE CrossRefGpUsersT SET LocationID = 0 WHERE LocationID IS NULL;
GO

-- 2. Change columns from nullable to NOT NULL
ALTER TABLE CrossRefGpUsersT ALTER COLUMN GroupID    INT NOT NULL;
ALTER TABLE CrossRefGpUsersT ALTER COLUMN CountyID   INT NOT NULL;
ALTER TABLE CrossRefGpUsersT ALTER COLUMN StateID    INT NOT NULL;
ALTER TABLE CrossRefGpUsersT ALTER COLUMN LocationID INT NOT NULL;
GO

-- 3. Add DEFAULT 0 constraints (only if they don't already exist)
IF NOT EXISTS (
    SELECT 1 FROM sys.default_constraints
    WHERE parent_object_id = OBJECT_ID('CrossRefGpUsersT')
      AND name = 'DF_CrossRef_GroupID'
)
    ALTER TABLE CrossRefGpUsersT ADD CONSTRAINT DF_CrossRef_GroupID    DEFAULT 0 FOR GroupID;

IF NOT EXISTS (
    SELECT 1 FROM sys.default_constraints
    WHERE parent_object_id = OBJECT_ID('CrossRefGpUsersT')
      AND name = 'DF_CrossRef_CountyID'
)
    ALTER TABLE CrossRefGpUsersT ADD CONSTRAINT DF_CrossRef_CountyID   DEFAULT 0 FOR CountyID;

IF NOT EXISTS (
    SELECT 1 FROM sys.default_constraints
    WHERE parent_object_id = OBJECT_ID('CrossRefGpUsersT')
      AND name = 'DF_CrossRef_StateID'
)
    ALTER TABLE CrossRefGpUsersT ADD CONSTRAINT DF_CrossRef_StateID    DEFAULT 0 FOR StateID;

IF NOT EXISTS (
    SELECT 1 FROM sys.default_constraints
    WHERE parent_object_id = OBJECT_ID('CrossRefGpUsersT')
      AND name = 'DF_CrossRef_LocationID'
)
    ALTER TABLE CrossRefGpUsersT ADD CONSTRAINT DF_CrossRef_LocationID DEFAULT 0 FOR LocationID;
GO

PRINT 'CrossRefGpUsersT nullable INT columns patched and DEFAULT 0 constraints added.';
GO
