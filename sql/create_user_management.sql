-- =============================================================================
-- User Management Schema
-- sql/create_user_management.sql
--
-- Run ONCE in SSMS against the central production database AFTER
-- create_patients_table.sql has already been executed.
--
-- What this script creates:
--   UserGroupT       — 4 role lookup rows (Data Entrant, County Supervisor,
--                      State Coordinator, National)
--   UserT            — user accounts (improved from original design — see notes)
--   CrossRefGpUsersT — user / role / geography cross-reference
--
-- SECURITY CHANGES FROM ORIGINAL DESIGN:
--   PwdHash       : BCrypt hash replaces Base64 encoding.
--                   Base64 is NOT encryption — it is trivially reversible.
--                   BCrypt is a one-way hash with a per-user salt and a
--                   configurable work factor, making brute-force impractical.
--   FgtPwdCodeHash: BCrypt hash of the 6-digit reset code (not the raw digits).
--   FgtPwdExpiry  : Explicit DATETIME of when the code expires (was a float
--                   Unix-style timestamp — less readable and error-prone).
--   CreatedAt     : Added for audit trail.
--   UNIQUE indexes: UserTID, UserName, EmailAddress — prevents duplicate accounts
--                   at the database level (defence in depth over app-only checks).
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

-- Safety: if the tables already exist, skip and print a message.
IF OBJECT_ID('CrossRefGpUsersT', 'U') IS NOT NULL
   OR OBJECT_ID('UserT', 'U') IS NOT NULL
   OR OBJECT_ID('UserGroupT', 'U') IS NOT NULL
BEGIN
    PRINT 'User management schema already exists — skipping.';
    RETURN;
END
GO

-- =============================================================================
-- 1. Remove the stub UsersT table created by create_patients_table.sql
--    (it was a placeholder with only UserTID + UserName).
-- =============================================================================
IF OBJECT_ID('UsersT', 'U') IS NOT NULL
    DROP TABLE UsersT;
GO

-- =============================================================================
-- 2. UserGroupT — role lookup
-- =============================================================================
CREATE TABLE UserGroupT (
    GroupID   INT          NOT NULL CONSTRAINT PK_UserGroupT PRIMARY KEY,
    GroupName NVARCHAR(100) NOT NULL
);
GO

INSERT INTO UserGroupT (GroupID, GroupName) VALUES
    (1, 'Data Entrant'),        -- facility staff: can enter, edit, delete, see own facility only
    (2, 'County Supervisor'),   -- DTLS: read-only for all facilities in their county
    (3, 'State Coordinator'),   -- Zonal: read-only for all facilities in their state
    (4, 'National');            -- NTP / NGO / SubRec: read-only, entire country
GO

-- =============================================================================
-- 3. UserT — user accounts
-- =============================================================================
CREATE TABLE UserT (
    -- Internal surrogate key. Rarely used across databases because of
    -- identity-seed conflicts on distributed devices. Use UserTID instead.
    UserID          INT           IDENTITY(1,1) NOT NULL,

    FullName        NVARCHAR(255) NULL,

    -- The value the user types to log in. Also used as their email address.
    UserName        NVARCHAR(255) NOT NULL,

    -- BCrypt hash of the password (NOT reversible encoding).
    -- Work factor 12 is the recommended minimum for 2024+.
    PwdHash         NVARCHAR(255) NULL,

    -- Which clinic / department this user belongs to.
    -- Foreign key to DataSourceT; kept nullable so national-level users
    -- (who have no single facility) can be stored without a dummy value.
    DataSourceID    INT           NULL,

    PhoneNo         NVARCHAR(255) NULL,

    -- Used both for contact and as an alternate login identifier.
    EmailAddress    NVARCHAR(255) NULL,

    -- 0 = pending, 1 = approved. All new accounts start at 0.
    ApprovedID      INT           NOT NULL CONSTRAINT DF_UserT_ApprovedID  DEFAULT 0,

    -- UserTID of the admin/supervisor who approved this account.
    ApprovedBy      VARCHAR(500)  NULL,
    DateApproved    DATETIME      NULL,

    -- Set to 1 when any field changes; the sync algorithm uses this to
    -- determine which rows to push to the central server.
    HasChanged      BIT           NOT NULL CONSTRAINT DF_UserT_HasChanged  DEFAULT 0,

    -- Soft delete: 0 = active, 1 = deleted. Never hard-delete rows so that
    -- patient records that reference this user's EnteredByID stay intact.
    Deleted         INT           NOT NULL CONSTRAINT DF_UserT_Deleted     DEFAULT 0,

    -- BCrypt hash of the 6-digit forgot-password code (not the raw digits).
    -- Storing the raw code would let a DB reader immediately reset any account.
    FgtPwdCodeHash  NVARCHAR(255) NULL,

    -- Exact UTC datetime when the reset code expires (30 minutes after issue).
    -- Replaces the original float Unix timestamp which was error-prone.
    FgtPwdExpiry    DATETIME      NULL,

    LastUpdated     DATETIME      NOT NULL CONSTRAINT DF_UserT_LastUpdated DEFAULT GETDATE(),
    CreatedAt       DATETIME      NOT NULL CONSTRAINT DF_UserT_CreatedAt   DEFAULT GETDATE(),

    -- Application-level unique identifier — a GUID generated in C#.
    -- This is the primary key used across distributed databases / devices
    -- because IDENTITY integers can collide when local copies sync.
    UserTID         VARCHAR(500)  NOT NULL,

    CONSTRAINT PK_UserT              PRIMARY KEY CLUSTERED (UserID ASC),
    CONSTRAINT UQ_UserT_UserTID      UNIQUE (UserTID),
    CONSTRAINT UQ_UserT_UserName     UNIQUE (UserName),
    CONSTRAINT UQ_UserT_EmailAddress UNIQUE (EmailAddress)
);

CREATE INDEX IX_UserT_Deleted    ON UserT(Deleted);
CREATE INDEX IX_UserT_ApprovedID ON UserT(ApprovedID);
GO

-- =============================================================================
-- 4. CrossRefGpUsersT — user / role / geography cross-reference
--
-- Role flags (bit columns):
--   DTLS        = 1  →  County Supervisor (District TB / Leprosy Supervisor)
--   Zonal       = 1  →  State Coordinator
--   NTP         = 1  →  National (NTP manager)
--   NGO         = 1  →  NGO / Sub-Recipient partner
--   AdminID     = 1  →  Can approve accounts and manage users
--   SuperUserID = 1  →  Full system access
--
-- Geographic scope columns:
--   DataSourceID comes from UserT (the user's facility).
--   CountyID / StateID / CountryID / DistrictID are foreign keys to tables
--   that you will create manually — no FK constraints are enforced here to
--   avoid a hard dependency on tables that may not exist in all environments.
-- =============================================================================
CREATE TABLE CrossRefGpUsersT (
    CrossRefTID INT          IDENTITY(1,1) NOT NULL,

    -- Links to UserT.UserTID (VARCHAR GUID, not the integer UserID).
    UserTID     VARCHAR(500) NOT NULL,

    -- FK to UserGroupT (1–4).
    GroupID     INT          NULL,

    -- Geographic scope — only the columns relevant to the user's role are filled.
    CountyID    INT          NULL,   -- County Supervisor scope
    StateID     INT          NULL,   -- State Coordinator scope
    LocationID  INT          NULL,   -- NGO regional office

    -- Role flags (mirrors original design for backward compatibility)
    DTLS        BIT          NOT NULL CONSTRAINT DF_CrossRef_DTLS        DEFAULT 0,
    Zonal       BIT          NOT NULL CONSTRAINT DF_CrossRef_Zonal       DEFAULT 0,
    NTP         BIT          NOT NULL CONSTRAINT DF_CrossRef_NTP         DEFAULT 0,
    NGO         BIT          NOT NULL CONSTRAINT DF_CrossRef_NGO         DEFAULT 0,

    -- Sub-Recipient (NGO) identifier; 0 means no NGO affiliation.
    SubRecID    INT          NOT NULL CONSTRAINT DF_CrossRef_SubRecID    DEFAULT 0,

    HasChanged  BIT          NOT NULL CONSTRAINT DF_CrossRef_HasChanged  DEFAULT 0,
    CountryID   INT          NOT NULL CONSTRAINT DF_CrossRef_CountryID   DEFAULT 1,
    DistrictID  INT          NOT NULL CONSTRAINT DF_CrossRef_DistrictID  DEFAULT 0,
    AdminID     INT          NOT NULL CONSTRAINT DF_CrossRef_AdminID     DEFAULT 0,
    SuperUserID INT          NOT NULL CONSTRAINT DF_CrossRef_SuperUserID DEFAULT 0,

    CONSTRAINT PK_CrossRefGpUsersT   PRIMARY KEY CLUSTERED (CrossRefTID ASC),
    CONSTRAINT FK_CrossRef_UserT     FOREIGN KEY (UserTID)  REFERENCES UserT(UserTID),
    CONSTRAINT FK_CrossRef_UserGroup FOREIGN KEY (GroupID)  REFERENCES UserGroupT(GroupID)
);

CREATE INDEX IX_CrossRef_UserTID  ON CrossRefGpUsersT(UserTID);
CREATE INDEX IX_CrossRef_CountyID ON CrossRefGpUsersT(CountyID);
CREATE INDEX IX_CrossRef_StateID  ON CrossRefGpUsersT(StateID);
GO

PRINT 'User management schema created successfully.';
GO
