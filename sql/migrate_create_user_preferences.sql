-- =============================================================================
-- migrate_create_user_preferences.sql
-- Creates UserPreferencesT — per-user configurable settings for the PWA.
--
-- All columns have safe defaults so existing users who have not yet saved
-- preferences get exactly the same behaviour as before this migration.
--
-- Run once per environment (IF NOT EXISTS guard makes it safe to re-run).
-- =============================================================================

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'UserPreferencesT')
BEGIN
    CREATE TABLE UserPreferencesT (
        UserTID                 VARCHAR(500)  NOT NULL,

        -- ── Clinical Thresholds (TB monitoring & DQ) ──────────────────────
        -- RegDate lookback used in monitoring HIV/CPT/ART patient counts and
        -- the sametbno DQ check. Default: 365 days.
        TbLookbackDays          INT           NOT NULL DEFAULT 365,

        -- Outcome eligibility window for NEW patients (PtTypeID=1).
        -- Patients within this range after DateRxStarted show under "Outcome Due".
        OutcomeEligNewMin       INT           NOT NULL DEFAULT 168,
        OutcomeEligNewMax       INT           NOT NULL DEFAULT 270,

        -- Outcome eligibility window for RETREATMENT patients (PtTypeID in 2,3,4,6).
        OutcomeEligReTxMin      INT           NOT NULL DEFAULT 224,
        OutcomeEligReTxMax      INT           NOT NULL DEFAULT 320,

        -- DQ: patients with NO outcome recorded but old enough to expect one.
        -- New patients (days since DateRxStarted).
        DqNoOutcomeNewMin       INT           NOT NULL DEFAULT 180,
        DqNoOutcomeNewMax       INT           NOT NULL DEFAULT 540,

        -- Retreatment patients.
        DqNoOutcomeReTxMin      INT           NOT NULL DEFAULT 240,
        DqNoOutcomeReTxMax      INT           NOT NULL DEFAULT 600,

        -- DQ: grace period for missing DiagMethodID (days since RegDate).
        DqDiagMethodDays        INT           NOT NULL DEFAULT 180,

        -- ── Data Entry ────────────────────────────────────────────────────
        -- 0 = load all records (up to server-side 5 000 cap);
        -- N > 0 = load only the most recent N records.
        ArtLoadLimit            INT           NOT NULL DEFAULT 0,

        -- Enable / disable duplicate name check in DQ counts.
        DupNameCheckEnabled     BIT           NOT NULL DEFAULT 1,

        -- ── Monitoring ────────────────────────────────────────────────────
        -- Default monitoring view: 'missed' | 'due'
        DefaultMonMode          NVARCHAR(10)  NOT NULL DEFAULT 'missed',

        -- Rows fetched per batch in the monitoring patient list.
        MonRowsPerPage          INT           NOT NULL DEFAULT 500,

        -- ── Reports ───────────────────────────────────────────────────────
        -- Default period type selected when the report modal opens.
        -- 'monthly' | 'quarterly' | 'semi-annual' | 'annual'
        DefaultReportPeriodType NVARCHAR(20)  NOT NULL DEFAULT 'monthly',

        -- 0 = no default (show placeholder); N = pre-select this facility.
        DefaultReportFacilityID INT           NOT NULL DEFAULT 0,

        -- ── Session & Security ────────────────────────────────────────────
        -- Minutes of inactivity before the warning banner appears.
        InactivityWarnMinutes   INT           NOT NULL DEFAULT 13,

        -- Minutes after the warning before the user is automatically signed out.
        AutoLogoutMinutes       INT           NOT NULL DEFAULT 2,

        -- Background sync interval in minutes.
        SyncIntervalMinutes     INT           NOT NULL DEFAULT 5,

        -- ── Display & Usability ───────────────────────────────────────────
        -- Maximum characters shown for a patient name before truncation.
        NameTruncLength         INT           NOT NULL DEFAULT 15,

        -- Hide the "Monitor TB Patients" dashboard card.
        ShowTbSection           BIT           NOT NULL DEFAULT 1,

        -- Hide the "Check Data Quality" dashboard card.
        ShowDqSection           BIT           NOT NULL DEFAULT 1,

        -- If 1, skip the PIN enrollment prompt after online login.
        PinEnrollDismissed      BIT           NOT NULL DEFAULT 0,

        -- Automatically close the pre-report DQ panel when all checks pass.
        DqAutoClose             BIT           NOT NULL DEFAULT 0,

        -- Compact table mode: hides secondary columns for smaller screens.
        CompactTableMode        BIT           NOT NULL DEFAULT 0,

        UpdatedAt               DATETIME2     NOT NULL DEFAULT GETUTCDATE(),

        CONSTRAINT PK_UserPreferencesT
            PRIMARY KEY (UserTID),
        CONSTRAINT FK_UserPreferencesT_UserT
            FOREIGN KEY (UserTID) REFERENCES UserT(UserTID)
    );
END
