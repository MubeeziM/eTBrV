-- Adds delta-sync tracking columns to MigratedFacilitiesT.
-- Run once against the new database before using the delta sync feature.
ALTER TABLE MigratedFacilitiesT
    ADD LastDeltaSyncOn        datetime2 NULL,
        LastDeltaSyncPatients  int       NULL,
        LastDeltaSyncFollowUps int       NULL;
