-- =============================================================================
-- ART Patient Register — SQL Server 2025 Schema
-- sql/create_patients_table.sql
--
-- Run this script ONCE in SSMS against the central production database.
-- SSMS steps:
--   1. Connect to your SQL Server instance.
--   2. Open this file (File → Open → File…).
--   3. Change the USE statement below if needed, then press F5 to execute.
-- =============================================================================

USE [db_ac602a_v6nkwi3rvw];
GO

-- Safety: skip if already created
IF OBJECT_ID('PtDetailsARTT', 'U') IS NOT NULL
BEGIN
  PRINT 'Schema already exists — skipping.';
  RETURN;
END
GO

-- =============================================================================
-- LOOKUP / REFERENCE TABLES
-- =============================================================================

CREATE TABLE SexT (
  SexID   INTEGER NOT NULL CONSTRAINT PK_SexT PRIMARY KEY,
  Sex     VARCHAR(30) NOT NULL
);

CREATE TABLE OccupationT (
  OccupationID  INTEGER NOT NULL CONSTRAINT PK_OccupationT PRIMARY KEY,
  Occupation    VARCHAR(60) NOT NULL
);

CREATE TABLE KeyPopuT (
  KeyPopuID  INTEGER NOT NULL CONSTRAINT PK_KeyPopuT PRIMARY KEY,
  KeyPopu    VARCHAR(60) NOT NULL
);

CREATE TABLE WHOStageT (
  WHOStageID  INTEGER NOT NULL CONSTRAINT PK_WHOStageT PRIMARY KEY,
  WHOStage    VARCHAR(30) NOT NULL
);

CREATE TABLE BreastfeedingT (
  BreastfeedingID  INTEGER NOT NULL CONSTRAINT PK_BreastfeedingT PRIMARY KEY,
  Breastfeeding    VARCHAR(30) NOT NULL
);

CREATE TABLE CPTDrugT (
  CPTDrugID  INTEGER NOT NULL CONSTRAINT PK_CPTDrugT PRIMARY KEY,
  CPTDrug    VARCHAR(60) NOT NULL
);

CREATE TABLE RegimenCategoryT (
  RegimenCategoryID  INTEGER NOT NULL CONSTRAINT PK_RegimenCategoryT PRIMARY KEY,
  RegimenCategory    VARCHAR(40) NOT NULL
);

CREATE TABLE RegimenARTT (
  RegimenID          INTEGER NOT NULL CONSTRAINT PK_RegimenARTT PRIMARY KEY,
  Regimen            VARCHAR(120) NOT NULL,
  RegimenCode        VARCHAR(10) NOT NULL,
  RegimenCategoryID  INTEGER NOT NULL
    CONSTRAINT FK_RegimenARTT_Category REFERENCES RegimenCategoryT(RegimenCategoryID)
);

CREATE TABLE RegimenChangeReasonT (
  RegimenChangeReasonID  INTEGER NOT NULL CONSTRAINT PK_RegimenChangeReasonT PRIMARY KEY,
  RegimenChangeReason    VARCHAR(80) NOT NULL
);

CREATE TABLE FollowUpStatusT (
  FollowUpStatusID  INTEGER NOT NULL CONSTRAINT PK_FollowUpStatusT PRIMARY KEY,
  FollowUpStatus    VARCHAR(40) NOT NULL
);

CREATE TABLE TBStatusT (
  TBStatusID  INTEGER NOT NULL CONSTRAINT PK_TBStatusT PRIMARY KEY,
  TBStatus    VARCHAR(40) NOT NULL
);

CREATE TABLE StopReasonT (
  StopReasonID  INTEGER NOT NULL CONSTRAINT PK_StopReasonT PRIMARY KEY,
  StopReason    VARCHAR(80) NOT NULL
);

CREATE TABLE CountyT (
  CountyID  INTEGER NOT NULL CONSTRAINT PK_CountyT PRIMARY KEY,
  County    VARCHAR(60) NOT NULL
);

CREATE TABLE StateT (
  StateID  INTEGER NOT NULL CONSTRAINT PK_StateT PRIMARY KEY,
  State    VARCHAR(60) NOT NULL
);

CREATE TABLE HealthFacilityT (
  HealthFacilityID  INTEGER NOT NULL CONSTRAINT PK_HealthFacilityT PRIMARY KEY,
  HealthFacility    VARCHAR(100) NOT NULL,
  CountyID          INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_HealthFacilityT_County REFERENCES CountyT(CountyID),
  StateID           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE DataSourceT (
  DataSourceID      INTEGER NOT NULL CONSTRAINT PK_DataSourceT PRIMARY KEY,
  DataSource        VARCHAR(100) NOT NULL,
  HealthFacilityID  INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_DataSourceT_HFacility REFERENCES HealthFacilityT(HealthFacilityID)
);

CREATE TABLE UsersT (
  UserTID   UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID()
    CONSTRAINT PK_UsersT PRIMARY KEY,
  UserName  VARCHAR(100) NOT NULL
);
GO

-- =============================================================================
-- SEED LOOKUP DATA
-- =============================================================================

INSERT INTO SexT VALUES (0,'Not recorded'),(1,'Male'),(2,'Female');

INSERT INTO OccupationT VALUES
  (0,'Not recorded'),(1,'Unemployed'),(2,'Student'),(3,'Housewife'),
  (4,'Salaried Employee'),(5,'Military personnel'),(6,'Other Uniformed forces'),
  (7,'Business'),(8,'Farmer'),(9,'Other (specify)');

INSERT INTO KeyPopuT VALUES
  (0,'Not recorded'),(1,'FSW'),(2,'MSM'),(3,'IDU'),
  (4,'Other (Specify)'),(5,'N/A');

INSERT INTO WHOStageT VALUES
  (0,'Not recorded'),(1,'Stage I'),(2,'Stage II'),(3,'Stage III'),(4,'Stage IV');

INSERT INTO BreastfeedingT VALUES
  (0,'Not recorded'),(1,'No'),(2,'Yes'),(3,'N/A');

INSERT INTO CPTDrugT VALUES
  (0,'Not given'),(1,'CTX (Cotrimoxazole)'),(2,'Dapsone');

INSERT INTO RegimenCategoryT VALUES
  (0,'Not recorded'),(1,'Adult 1st Line'),(2,'Adult 2nd Line'),
  (3,'Child 1st Line'),(4,'Child 2nd Line');

INSERT INTO RegimenARTT (RegimenID, Regimen, RegimenCode, RegimenCategoryID) VALUES
  (1,'TDF + 3TC + DTG','1a',1),(2,'TDF + 3TC + EFV','1b',1),
  (3,'AZT + 3TC + DTG','1c',1),(4,'AZT + 3TC + NVP','1d',1),
  (5,'AZT + 3TC + EFV','1e',1),(6,'ABC + 3TC + DTG','1f',1),
  (7,'ABC + 3TC + EFV','1g',1),(8,'TDF + 3TC + NVP','1h',1),
  (9,'TDF + FTC + DTG','1j',1),
  (10,'AZT + 3TC + LPV/r','2a',2),(11,'AZT + 3TC + ATV/r','2b',2),
  (12,'TDF + 3TC + LPV/r','2c',2),(13,'TDF + 3TC + ATV/r','2d',2),
  (14,'ABC + 3TC + LPV/r','2e',2),(15,'ABC + 3TC + ATV/r','2f',2),
  (16,'AZT + 3TC + DTG','2g',2),(17,'TDF + 3TC + DTG','2h',2),
  (18,'ABC + 3TC + DTG','2i',2),(19,'TDF + FTC + LPV/r','2j',2),
  (20,'TDF + FTC + ATV/r','2k',2),
  (21,'ABC + 3TC + LPV/r','4a',3),(22,'AZT + 3TC + LPV/r','4b',3),
  (23,'TDF + 3TC + LPV/r','4c',3),(24,'ABC + 3TC + DTG','4d',3),
  (25,'AZT + 3TC + DTG','4f',3),(26,'TDF + 3TC + DTG','4g',3),
  (27,'ABC + 3TC + NVP','4h',3),(28,'AZT + 3TC + NVP','4i',3),
  (29,'TDF + 3TC + EFV','4j',3),(30,'ABC + 3TC + EFV','4k',3),
  (31,'AZT + 3TC + EFV','4l',3),
  (32,'ABC + 3TC + LPV/r','5a',4),(33,'AZT + 3TC + LPV/r','5b',4),
  (34,'TDF + 3TC + LPV/r','5c',4),(35,'ABC + 3TC + ATV/r','5d',4),
  (36,'AZT + 3TC + ATV/r','5e',4),(37,'TDF + 3TC + ATV/r','5f',4),
  (38,'ABC + 3TC + DTG','5g',4),(39,'AZT + 3TC + DTG','5h',4),
  (40,'TDF + 3TC + DTG','5i',4);

INSERT INTO RegimenChangeReasonT VALUES
  (0,'N/A'),(1,'Toxicity/side effects'),(2,'Pregnancy'),(3,'Risk of pregnancy'),
  (4,'Due to new TB'),(5,'New drug available'),(6,'Drug out of stock'),
  (7,'Other reason (specify)'),(8,'Clinical treatment failure'),
  (9,'Immunologic failure'),(10,'Virologic failure');

INSERT INTO FollowUpStatusT VALUES
  (0,'Not recorded'),(1,'On ART'),(2,'Dead'),(3,'Stop'),(4,'Missed'),
  (5,'LTFU - Lost to Follow Up'),(6,'TO - Transferred Out');

INSERT INTO TBStatusT VALUES
  (0,'Not recorded'),(1,'No signs'),(2,'Pre TB (Presumptive TB)'),
  (3,'INH (on INH prophylaxis)'),(4,'TB Rx (on TB treatment)'),(5,'ND - Not Done');

INSERT INTO StopReasonT VALUES
  (0,'N/A'),(1,'Toxicity/side effects'),(2,'Pregnancy'),(3,'Treatment failure'),
  (4,'Poor adherence'),(5,'Illness/hospitalization'),(6,'Drugs out of stock'),
  (7,'Patient lack finances'),(8,'Other patient decision'),
  (9,'Planned treatment interruption'),(10,'Other');

INSERT INTO CountyT VALUES (0,'Not configured');
INSERT INTO StateT VALUES (0,'Not configured');
INSERT INTO HealthFacilityT VALUES (0,'Not configured',0,0);
INSERT INTO DataSourceT VALUES (0,'Not configured',0);
GO

-- =============================================================================
-- VIEW: vwGeogAreaQ — geographic hierarchy flat view used by PWA geo-tree
-- =============================================================================
GO
CREATE VIEW vwGeogAreaQ AS
    SELECT hf.HealthFacilityID,
           hf.HealthFacility,
           hf.CountyID,
           COALESCE(c.County, '') AS County,
           hf.StateID,
           COALESCE(s.State,  '') AS State
    FROM   HealthFacilityT hf
    LEFT JOIN CountyT c ON hf.CountyID = c.CountyID
    LEFT JOIN StateT  s ON hf.StateID  = s.StateID
    WHERE  hf.HealthFacilityID NOT IN (0, 15, 17, 435)
      AND  COALESCE(s.State, '') NOT LIKE '%Training%'
      AND  hf.eTBrDHIS = 1;

-- =============================================================================
-- MAIN TABLE: PtDetailsARTT
-- =============================================================================

CREATE TABLE PtDetailsARTT (
  PtDetailsTID          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID()
                          CONSTRAINT PK_PtDetailsARTT PRIMARY KEY,
  PatientID             INTEGER IDENTITY(1,1) NOT NULL,
  NearestHFID           INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_PtDetailsARTT_HF REFERENCES HealthFacilityT(HealthFacilityID),
  DataSourceID          INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_PtDetailsARTT_DS REFERENCES DataSourceT(DataSourceID),
  CountyID              INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_PtDetailsARTT_County REFERENCES CountyT(CountyID),
  EnteredByID           UNIQUEIDENTIFIER NULL,
  HasChanged            INTEGER NOT NULL DEFAULT 1,
  LastModOn             DATETIME2(3) NOT NULL DEFAULT GETDATE(),
  CreatedOn             DATETIME2(3) NOT NULL DEFAULT GETDATE(),
  HIVRetest             INTEGER NOT NULL DEFAULT 0,
  ARTNo                 VARCHAR(30) NOT NULL,
  ARTStartDate          DATE NULL,
  DateEnrolledInCare    DATE NULL,
  PtName                VARCHAR(100) NOT NULL,
  ResidenceAddress      VARCHAR(200) NULL,
  Phone1                VARCHAR(15) NULL,
  Phone2                VARCHAR(15) NULL,
  OccupationID          INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_PtDetailsARTT_Occ REFERENCES OccupationT(OccupationID),
  OccupationOther       VARCHAR(100) NULL,
  KeyPopuID             INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_PtDetailsARTT_KP REFERENCES KeyPopuT(KeyPopuID),
  KeyPopuOther          VARCHAR(100) NULL,
  Age                   INTEGER NOT NULL DEFAULT 0,
  DateOfBirth           DATE NULL,
  SexID                 INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_PtDetailsARTT_Sex REFERENCES SexT(SexID),
  WeightKg              DECIMAL(5,1) NULL,
  HeightCm              DECIMAL(5,1) NULL,
  MUACCm                DECIMAL(4,1) NULL,
  BMI                   DECIMAL(5,2) NULL,
  WHOStageID            INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_PtDetailsARTT_WHO REFERENCES WHOStageT(WHOStageID),
  CD4Value              DECIMAL(7,1) NULL,
  CD4IsPercent          INTEGER NOT NULL DEFAULT 0,
  CPTStartDate          DATE NULL,
  CPTDrugID             INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_PtDetailsARTT_CPT REFERENCES CPTDrugT(CPTDrugID),
  TBRxStartDate         DATE NULL,
  UnitTBNo              VARCHAR(50) NULL,
  TBStatusID            INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_PtDetailsARTT_TBStatus REFERENCES TBStatusT(TBStatusID),
  BreastfeedingID       INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_PtDetailsARTT_BF REFERENCES BreastfeedingT(BreastfeedingID),
  IsTransferIn          INTEGER NOT NULL DEFAULT 0,
  TransferFromFacility  VARCHAR(100) NULL,
  GuardianName          VARCHAR(100) NULL,
  GuardianPhone1        VARCHAR(15) NULL,
  CONSTRAINT UQ_PtDetailsARTT_ARTNo UNIQUE (ARTNo)
);

CREATE INDEX IX_PtDetailsARTT_ARTNo        ON PtDetailsARTT(ARTNo);
CREATE INDEX IX_PtDetailsARTT_PtName      ON PtDetailsARTT(PtName);
CREATE INDEX IX_PtDetailsARTT_ARTStartDate ON PtDetailsARTT(ARTStartDate);
CREATE INDEX IX_PtDetailsARTT_HasChanged   ON PtDetailsARTT(HasChanged);
GO

-- =============================================================================
-- CHILD TABLES
-- =============================================================================

CREATE TABLE INHProphylaxisT (
  INHProphylaxisTID  UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID()
                       CONSTRAINT PK_INHProphylaxisT PRIMARY KEY,
  PtDetailsTID       UNIQUEIDENTIFIER NOT NULL
    CONSTRAINT FK_INH_PtDetails REFERENCES PtDetailsARTT(PtDetailsTID),
  SequenceNo         INTEGER NOT NULL,
  INHDate            DATE NULL,
  EnteredByID        UNIQUEIDENTIFIER NULL,
  HasChanged         INTEGER NOT NULL DEFAULT 1,
  LastModOn          DATETIME2(3) NOT NULL DEFAULT GETDATE(),
  CreatedOn          DATETIME2(3) NOT NULL DEFAULT GETDATE()
);
CREATE INDEX IX_INHProphylaxisT_PtDetailsTID ON INHProphylaxisT(PtDetailsTID);

CREATE TABLE PMTCTPregnancyT (
  PMTCTPregnancyTID   UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID()
                        CONSTRAINT PK_PMTCTPregnancyT PRIMARY KEY,
  PtDetailsTID        UNIQUEIDENTIFIER NOT NULL
    CONSTRAINT FK_PMTCT_PtDetails REFERENCES PtDetailsARTT(PtDetailsTID),
  PregnancyNo         INTEGER NOT NULL,
  ANCNo               VARCHAR(50) NULL,
  DeliveryDate        DATE NULL,
  MotherReceivedART   INTEGER NOT NULL DEFAULT 0,
  InfantReceivedARVs  INTEGER NOT NULL DEFAULT 0,
  EnteredByID         UNIQUEIDENTIFIER NULL,
  HasChanged          INTEGER NOT NULL DEFAULT 1,
  LastModOn           DATETIME2(3) NOT NULL DEFAULT GETDATE(),
  CreatedOn           DATETIME2(3) NOT NULL DEFAULT GETDATE()
);
CREATE INDEX IX_PMTCTPregnancyT_PtDetailsTID ON PMTCTPregnancyT(PtDetailsTID);

CREATE TABLE RegimenHistoryT (
  RegimenHistoryTID   UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID()
                        CONSTRAINT PK_RegimenHistoryT PRIMARY KEY,
  PtDetailsTID        UNIQUEIDENTIFIER NOT NULL
    CONSTRAINT FK_RegimenHistory_PtDetails REFERENCES PtDetailsARTT(PtDetailsTID),
  RegimenLine         INTEGER NOT NULL,
  SequenceNo          INTEGER NOT NULL,
  RegimenID           INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_RegimenHistory_Regimen REFERENCES RegimenARTT(RegimenID),
  ChangeReasonID      INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_RegimenHistory_Reason REFERENCES RegimenChangeReasonT(RegimenChangeReasonID),
  OtherReasonText     VARCHAR(200) NULL,
  EventDate           DATE NULL,
  EnteredByID         UNIQUEIDENTIFIER NULL,
  HasChanged          INTEGER NOT NULL DEFAULT 1,
  LastModOn           DATETIME2(3) NOT NULL DEFAULT GETDATE(),
  CreatedOn           DATETIME2(3) NOT NULL DEFAULT GETDATE()
);
CREATE INDEX IX_RegimenHistoryT_PtDetailsTID ON RegimenHistoryT(PtDetailsTID);

CREATE TABLE PtFollowUpARTT (
  PtFollowUpTID      UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID()
                       CONSTRAINT PK_PtFollowUpARTT PRIMARY KEY,
  PtDetailsTID       UNIQUEIDENTIFIER NOT NULL
    CONSTRAINT FK_FollowUp_PtDetails REFERENCES PtDetailsARTT(PtDetailsTID),
  VisitDate          DATE NULL,
  VisitMonth         INTEGER NULL,
  FollowUpStatusID   INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_FollowUp_Status REFERENCES FollowUpStatusT(FollowUpStatusID),
  RegimenID          INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_FollowUp_Regimen REFERENCES RegimenARTT(RegimenID),
  TBStatusID         INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_FollowUp_TBStatus REFERENCES TBStatusT(TBStatusID),
  StopReasonID       INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_FollowUp_StopReason REFERENCES StopReasonT(StopReasonID),
  StopOtherText      VARCHAR(200) NULL,
  WeeksInterrupted   INTEGER NULL,
  WeightKg           DECIMAL(5,1) NULL,
  HeightCm           DECIMAL(5,1) NULL,
  BMI                DECIMAL(5,2) NULL,
  CPTDrugID          INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_FollowUp_CPT REFERENCES CPTDrugT(CPTDrugID),
  CD4Value           DECIMAL(7,1) NULL,
  CD4IsPercent       INTEGER NOT NULL DEFAULT 0,
  ViralLoad          VARCHAR(30) NULL,
  Notes              VARCHAR(500) NULL,
  EnteredByID        UNIQUEIDENTIFIER NULL,
  HasChanged         INTEGER NOT NULL DEFAULT 1,
  LastModOn          DATETIME2(3) NOT NULL DEFAULT GETDATE(),
  CreatedOn          DATETIME2(3) NOT NULL DEFAULT GETDATE()
);
CREATE INDEX IX_PtFollowUpARTT_PtDetailsTID ON PtFollowUpARTT(PtDetailsTID);
CREATE INDEX IX_PtFollowUpARTT_VisitDate    ON PtFollowUpARTT(VisitDate);
CREATE INDEX IX_PtFollowUpARTT_HasChanged   ON PtFollowUpARTT(HasChanged);
GO

PRINT 'ART Register schema created and seeded successfully.';
GO

-- =============================================================================
-- PATCH: Run this separately if the tables were already created without TBStatusID
-- =============================================================================
IF COL_LENGTH('PtDetailsARTT','TBStatusID') IS NULL
BEGIN
  ALTER TABLE PtDetailsARTT ADD TBStatusID INTEGER NOT NULL DEFAULT 0
    CONSTRAINT FK_PtDetailsARTT_TBStatus REFERENCES TBStatusT(TBStatusID);
  PRINT 'PATCH: TBStatusID added to PtDetailsARTT.';
END
GO
