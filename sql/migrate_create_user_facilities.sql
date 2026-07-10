-- ============================================================================
-- Migrate: Create UserFacilitiesT — per-user explicit facility access list.
--
-- When a user has rows here, only those facilities are accessible to them
-- (overrides the default county / state scope rules).
-- An empty set means "use default scope" (no restriction).
--
-- Run once against the target database.
-- ============================================================================
IF NOT EXISTS (
    SELECT 1 FROM sys.objects
    WHERE  name = 'UserFacilitiesT' AND type = 'U'
)
BEGIN
    CREATE TABLE UserFacilitiesT (
        UserTID          VARCHAR(500) NOT NULL,
        HealthFacilityID INT          NOT NULL,
        CreatedAt        DATETIME     NOT NULL DEFAULT GETDATE(),
        CreatedBy        VARCHAR(500) NULL,
        CONSTRAINT PK_UserFacilitiesT
            PRIMARY KEY (UserTID, HealthFacilityID),
        CONSTRAINT FK_UserFacilitiesT_User
            FOREIGN KEY (UserTID) REFERENCES UserT(UserTID)
    );

    PRINT 'UserFacilitiesT created successfully.';
END
ELSE
BEGIN
    PRINT 'UserFacilitiesT already exists — skipped.';
END
GO
