-- =============================================================================
-- migrate_tb_repair_lookup_seeds.sql
--
-- Ensures every TB register lookup table has a row with ID = 0 ('Not recorded').
-- Run this if create_tb_register.sql skipped some tables because they already
-- existed (without their seed data), causing FK error 547 during sync.
--
-- Safe to re-run — uses INSERT WHERE NOT EXISTS (no duplicates).
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

-- ── SputumResultT ────────────────────────────────────────────────────────────
IF OBJECT_ID('SputumResultT', 'U') IS NOT NULL
BEGIN
    IF NOT EXISTS (SELECT 1 FROM SputumResultT WHERE SputumResultID = 0)
        INSERT INTO SputumResultT (SputumResultID, SputumResult, OrderBy) VALUES (0, N'Not recorded', 0);
    IF NOT EXISTS (SELECT 1 FROM SputumResultT WHERE SputumResultID = 1)
        INSERT INTO SputumResultT (SputumResultID, SputumResult, OrderBy) VALUES (1, N'Scanty AFBs Seen', 2);
    IF NOT EXISTS (SELECT 1 FROM SputumResultT WHERE SputumResultID = 2)
        INSERT INTO SputumResultT (SputumResultID, SputumResult, OrderBy) VALUES (2, N'No AFB Seen', 1);
    IF NOT EXISTS (SELECT 1 FROM SputumResultT WHERE SputumResultID = 3)
        INSERT INTO SputumResultT (SputumResultID, SputumResult, OrderBy) VALUES (3, N'Select One', 7);
    IF NOT EXISTS (SELECT 1 FROM SputumResultT WHERE SputumResultID = 4)
        INSERT INTO SputumResultT (SputumResultID, SputumResult, OrderBy) VALUES (4, N'1+ AFBs Seen', 3);
    IF NOT EXISTS (SELECT 1 FROM SputumResultT WHERE SputumResultID = 5)
        INSERT INTO SputumResultT (SputumResultID, SputumResult, OrderBy) VALUES (5, N'2+ AFBs Seen', 4);
    IF NOT EXISTS (SELECT 1 FROM SputumResultT WHERE SputumResultID = 6)
        INSERT INTO SputumResultT (SputumResultID, SputumResult, OrderBy) VALUES (6, N'3+ AFBs Seen', 5);
    IF NOT EXISTS (SELECT 1 FROM SputumResultT WHERE SputumResultID = 7)
        INSERT INTO SputumResultT (SputumResultID, SputumResult, OrderBy) VALUES (7, N'NO Smear Done', 6);
    PRINT 'SputumResultT seeded.';
END
ELSE PRINT 'SputumResultT does not exist — run create_tb_register.sql first.';
GO

-- ── DiagMethodT ──────────────────────────────────────────────────────────────
IF OBJECT_ID('DiagMethodT', 'U') IS NOT NULL
BEGIN
    IF NOT EXISTS (SELECT 1 FROM DiagMethodT WHERE DiagMethodID = 0)
        INSERT INTO DiagMethodT (DiagMethodID, DiagMethod, OrderID) VALUES (0, N'Not recorded', 0);
    IF NOT EXISTS (SELECT 1 FROM DiagMethodT WHERE DiagMethodID = 1)
        INSERT INTO DiagMethodT (DiagMethodID, DiagMethod, OrderID) VALUES (1, N'GeneXpert', 1);
    IF NOT EXISTS (SELECT 1 FROM DiagMethodT WHERE DiagMethodID = 2)
        INSERT INTO DiagMethodT (DiagMethodID, DiagMethod, OrderID) VALUES (2, N'Smear Microscopy', 2);
    IF NOT EXISTS (SELECT 1 FROM DiagMethodT WHERE DiagMethodID = 3)
        INSERT INTO DiagMethodT (DiagMethodID, DiagMethod, OrderID) VALUES (3, N'TB LAM', 3);
    IF NOT EXISTS (SELECT 1 FROM DiagMethodT WHERE DiagMethodID = 4)
        INSERT INTO DiagMethodT (DiagMethodID, DiagMethod, OrderID) VALUES (4, N'Truenat', 4);
    IF NOT EXISTS (SELECT 1 FROM DiagMethodT WHERE DiagMethodID = 5)
        INSERT INTO DiagMethodT (DiagMethodID, DiagMethod, OrderID) VALUES (5, N'Others:- Chest Xray/Clinically etc', 5);
    PRINT 'DiagMethodT seeded.';
END
ELSE PRINT 'DiagMethodT does not exist — run create_tb_register.sql first.';
GO

-- ── XpertResultT ─────────────────────────────────────────────────────────────
IF OBJECT_ID('XpertResultT', 'U') IS NOT NULL
BEGIN
    IF NOT EXISTS (SELECT 1 FROM XpertResultT WHERE XpertResultID = 0)
        INSERT INTO XpertResultT (XpertResultID, XpertResult, FullXpertResult) VALUES (0, N'Not recorded', N'Not recorded');
    PRINT 'XpertResultT ID=0 ensured.';
END
GO

-- ── HIVResultT ───────────────────────────────────────────────────────────────
IF OBJECT_ID('HIVResultT', 'U') IS NOT NULL
BEGIN
    IF NOT EXISTS (SELECT 1 FROM HIVResultT WHERE HIVResultID = 0)
        INSERT INTO HIVResultT (HIVResultID, HIVResult, OrderBy) VALUES (0, N'Not recorded', 0);
    PRINT 'HIVResultT ID=0 ensured.';
END
GO

-- ── TbTypeT ──────────────────────────────────────────────────────────────────
IF OBJECT_ID('TbTypeT', 'U') IS NOT NULL
BEGIN
    IF NOT EXISTS (SELECT 1 FROM TbTypeT WHERE TbTypeID = 0)
        INSERT INTO TbTypeT (TbTypeID, TbType) VALUES (0, N'Not recorded');
    PRINT 'TbTypeT ID=0 ensured.';
END
ELSE PRINT 'TbTypeT does not exist — run create_tb_register.sql first.';
GO

-- ── PtTypeT ──────────────────────────────────────────────────────────────────
IF OBJECT_ID('PtTypeT', 'U') IS NOT NULL
BEGIN
    IF NOT EXISTS (SELECT 1 FROM PtTypeT WHERE PtTypeID = 0)
        INSERT INTO PtTypeT (PtTypeID, PtType, PtTypeShort) VALUES (0, N'Not recorded', N'NR');
    PRINT 'PtTypeT ID=0 ensured.';
END
ELSE PRINT 'PtTypeT does not exist — run create_tb_register.sql first.';
GO

-- ── OutcomeT ─────────────────────────────────────────────────────────────────
IF OBJECT_ID('OutcomeT', 'U') IS NOT NULL
BEGIN
    IF NOT EXISTS (SELECT 1 FROM OutcomeT WHERE OutcomeID = 0)
        INSERT INTO OutcomeT (OutcomeID, Outcome) VALUES (0, N'Not recorded');
    PRINT 'OutcomeT ID=0 ensured.';
END
GO

-- ── RegimenT (TB-specific) ───────────────────────────────────────────────────
IF OBJECT_ID('RegimenT', 'U') IS NOT NULL
BEGIN
    IF NOT EXISTS (SELECT 1 FROM RegimenT WHERE RegimenID = 0)
        INSERT INTO RegimenT (RegimenID, Regimen, OrderByID) VALUES (0, N'Not recorded', 0);
    IF NOT EXISTS (SELECT 1 FROM RegimenT WHERE RegimenID = 1)
        INSERT INTO RegimenT (RegimenID, Regimen, OrderByID) VALUES (1, N'2HRZE/4RH', 1);
    IF NOT EXISTS (SELECT 1 FROM RegimenT WHERE RegimenID = 2)
        INSERT INTO RegimenT (RegimenID, Regimen, OrderByID) VALUES (2, N'2SHRZE/1HRZE/5RHE', 2);
    IF NOT EXISTS (SELECT 1 FROM RegimenT WHERE RegimenID = 3)
        INSERT INTO RegimenT (RegimenID, Regimen, OrderByID) VALUES (3, N'2HRZE/10RH', 3);
    IF NOT EXISTS (SELECT 1 FROM RegimenT WHERE RegimenID = 4)
        INSERT INTO RegimenT (RegimenID, Regimen, OrderByID) VALUES (4, N'Select One', 6);
    IF NOT EXISTS (SELECT 1 FROM RegimenT WHERE RegimenID = 5)
        INSERT INTO RegimenT (RegimenID, Regimen, OrderByID) VALUES (5, N'2RHZE/2RH', 4);
    IF NOT EXISTS (SELECT 1 FROM RegimenT WHERE RegimenID = 6)
        INSERT INTO RegimenT (RegimenID, Regimen, OrderByID) VALUES (6, N'2RHE/7RH', 5);
    PRINT 'RegimenT seeded.';
END
ELSE PRINT 'RegimenT does not exist — run create_tb_register.sql first.';
GO

-- ── ReferredByT ──────────────────────────────────────────────────────────────
IF OBJECT_ID('ReferredByT', 'U') IS NOT NULL
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ReferredByT WHERE ReferredByID = 0)
        INSERT INTO ReferredByT (ReferredByID, ReferredBy) VALUES (0, N'Not recorded');
    IF NOT EXISTS (SELECT 1 FROM ReferredByT WHERE ReferredByID = 1)
        INSERT INTO ReferredByT (ReferredByID, ReferredBy) VALUES (1, N'Self');
    IF NOT EXISTS (SELECT 1 FROM ReferredByT WHERE ReferredByID = 2)
        INSERT INTO ReferredByT (ReferredByID, ReferredBy) VALUES (2, N'Community Member');
    IF NOT EXISTS (SELECT 1 FROM ReferredByT WHERE ReferredByID = 3)
        INSERT INTO ReferredByT (ReferredByID, ReferredBy) VALUES (3, N'Public Facility');
    IF NOT EXISTS (SELECT 1 FROM ReferredByT WHERE ReferredByID = 4)
        INSERT INTO ReferredByT (ReferredByID, ReferredBy) VALUES (4, N'Private Clinic/Hospital');
    IF NOT EXISTS (SELECT 1 FROM ReferredByT WHERE ReferredByID = 5)
        INSERT INTO ReferredByT (ReferredByID, ReferredBy) VALUES (5, N'HHPs');
    IF NOT EXISTS (SELECT 1 FROM ReferredByT WHERE ReferredByID = 6)
        INSERT INTO ReferredByT (ReferredByID, ReferredBy) VALUES (6, N'Others');
    IF NOT EXISTS (SELECT 1 FROM ReferredByT WHERE ReferredByID = 7)
        INSERT INTO ReferredByT (ReferredByID, ReferredBy) VALUES (7, N'Select One');
    PRINT 'ReferredByT seeded.';
END
ELSE PRINT 'ReferredByT does not exist — run create_tb_register.sql first.';
GO

PRINT 'migrate_tb_repair_lookup_seeds.sql complete.';
GO
