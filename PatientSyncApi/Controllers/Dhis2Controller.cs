using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using ClosedXML.Excel;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;
using PatientSyncApi.Models;

namespace PatientSyncApi.Controllers;

/// <summary>
/// Handles generation, preview, and submission of quarterly TB (NTP) reports to DHIS2.
///
/// SECURITY:
///   - [Authorize] on all endpoints — unauthenticated callers receive 401.
///   - All SQL uses parameterised queries — no string concatenation of user input.
///   - DHIS2 credentials are read from server-side config only; never exposed to clients.
///   - Scope is enforced from JWT claims.
///
/// FLOW:
///   1. GET /api/dhis2/tb-prepare  — computes report data for all accessible facilities
///      and caches it; returns the facility list for the selection UI.
///   2. GET /api/dhis2/tb-preview  — exports a single facility's data to the NTP Excel
///      template so the user can verify before submitting.
///   3. POST /api/dhis2/tb-send    — submits selected facilities to the DHIS2 API and
///      returns per-facility success/failure feedback.
/// </summary>
[ApiController]
[Route("api/dhis2")]
[Authorize]
public sealed class Dhis2Controller : ControllerBase
{
    // ── DHIS2 dataset identifiers ─────────────────────────────────────────────
    private const string CfDataSet = "Bs4EW9iTTbc";  // Case Finding
    private const string ToDataSet = "wwM5jC074ap";  // Treatment Outcomes
    private const string DefaultAoc = "HllvX50cXC0"; // attributeOptionCombo (default)

    // ── DHIS2 data value mappings ─────────────────────────────────────────────
    // Each tuple: (variable name, dataElement UID, categoryOptionCombo UID, dataset)
    // Order must exactly match the order values are written in BuildCfValues / BuildToValues.
    // This matches the UPDATE statements in the original ntp_report.aspx.cs Page_Load.

    private static readonly (string De, string Coc)[] CfMapProduction =
    {
        // Case types
        ("MXPygGMFJyf", "jxFL8f5zw3G"), // cf_PBCNew
        ("MXPygGMFJyf", "dPSjY2kx9EZ"), // cf_PBCRelapse
        ("MXPygGMFJyf", "RTpRZNWomvh"), // cf_PBCPrevTreat
        ("MXPygGMFJyf", "ZSiMF813gUR"), // cf_PBCOther
        ("gBJsPO5Sq4F", "jxFL8f5zw3G"), // cf_PCDNew
        ("gBJsPO5Sq4F", "dPSjY2kx9EZ"), // cf_PCDRelapse
        ("gBJsPO5Sq4F", "RTpRZNWomvh"), // cf_PCDPrevTreat
        ("gBJsPO5Sq4F", "ZSiMF813gUR"), // cf_PCDOther
        ("tLA74ofV37x", "jxFL8f5zw3G"), // cf_EPNew
        ("tLA74ofV37x", "dPSjY2kx9EZ"), // cf_EPRelapse
        ("tLA74ofV37x", "RTpRZNWomvh"), // cf_EPPrevTreat
        ("tLA74ofV37x", "ZSiMF813gUR"), // cf_EPOther
        // New+Relapse by age/sex (male)
        ("SOzXMCzgOKB", "bPEY7jIIWtU"), // cf_PBCNewU5M
        ("SOzXMCzgOKB", "viaTEZCdO5b"), // cf_PBCNew5_9M
        ("SOzXMCzgOKB", "b1RYDWtEPVz"), // cf_PBCNew10_14M
        ("SOzXMCzgOKB", "aM6ZmmrjCNn"), // cf_PBCNew15_19M
        ("SOzXMCzgOKB", "ETjoFTNU5w0"), // cf_PBCNew20_24M
        ("SOzXMCzgOKB", "Zb9bUaVORZI"), // cf_PBCNew25_34M
        ("SOzXMCzgOKB", "jhfPv9e8Oxm"), // cf_PBCNew35_44M
        ("SOzXMCzgOKB", "G2tIjoSOd9v"), // cf_PBCNew45_54M
        ("SOzXMCzgOKB", "ETInBEGRA0Y"), // cf_PBCNew55_64M
        ("SOzXMCzgOKB", "du1eK0zJNtT"), // cf_PBCNew65PlusM
        // New+Relapse by age/sex (female)
        ("SOzXMCzgOKB", "nEMa3Ms0Gxf"), // cf_PBCNewU5F
        ("SOzXMCzgOKB", "R0ynuKPdSXA"), // cf_PBCNew5_9F
        ("SOzXMCzgOKB", "WtC6hO05XOb"), // cf_PBCNew10_14F
        ("SOzXMCzgOKB", "uRbNT4CFSyw"), // cf_PBCNew15_19F
        ("SOzXMCzgOKB", "gR1fq5BtlrS"), // cf_PBCNew20_24F
        ("SOzXMCzgOKB", "RJ9POsSy0gn"), // cf_PBCNew25_34F
        ("SOzXMCzgOKB", "NieFs69q88c"), // cf_PBCNew35_44F
        ("SOzXMCzgOKB", "cESPCa8XQh1"), // cf_PBCNew45_54F
        ("SOzXMCzgOKB", "nMBwniCaFKn"), // cf_PBCNew55_64F
        ("SOzXMCzgOKB", "aJP7R1qVIlZ"), // cf_PBCNew65PlusF
        // Presumptive cases / lab
        ("mnTeJKojXDu", "HllvX50cXC0"), // cf_SuspectsSeen
        ("Ga0Uz9Vd2ed", "HllvX50cXC0"), // cf_PBCLab
        // HIV activities
        ("Xnfuc0bReo2", "RXgmEQPmgKK"), // cf_TestedHIV
        ("Xnfuc0bReo2", "tznO3ytAWWP"), // cf_TestedHIVPos
        ("Xnfuc0bReo2", "x7us62aFEjK"), // cf_TestedHIVART
        ("Xnfuc0bReo2", "iSs98SgDs8O"), // cf_TestedHIVCPT
        // Diagnostic methods used
        ("Ui132KQgN1v", "XYWUL2edkCw"), // cf_GeneXpert
        ("Ui132KQgN1v", "gPRbmWmNtyN"), // cf_Microscopy
        ("Ui132KQgN1v", "kz1iKOYuQli"), // cf_TBLam
        ("Ui132KQgN1v", "vsHgzpLJKkR"), // cf_TrueNat
        ("Ui132KQgN1v", "F13nzEEGFk0"), // cf_Xray
        // Positive results by method
        ("FldClHDZoNn", "XYWUL2edkCw"), // cf_GeneXpert_Pos
        ("FldClHDZoNn", "gPRbmWmNtyN"), // cf_Microscopy_Pos
        ("FldClHDZoNn", "kz1iKOYuQli"), // cf_TBLam_Pos
        ("FldClHDZoNn", "vsHgzpLJKkR"), // cf_TrueNat_Pos
        ("FldClHDZoNn", "F13nzEEGFk0"), // cf_Xray_Pos (not in old code but slot kept)
        // HIV+ by age/sex (male)
        ("CB6u1gbtcU6", "bPEY7jIIWtU"), // cf_TestedHIVPosU5M
        ("CB6u1gbtcU6", "viaTEZCdO5b"), // cf_TestedHIVPos5_9M
        ("CB6u1gbtcU6", "b1RYDWtEPVz"), // cf_TestedHIVPos10_14M
        ("CB6u1gbtcU6", "aM6ZmmrjCNn"), // cf_TestedHIVPos15_19M
        ("CB6u1gbtcU6", "ETjoFTNU5w0"), // cf_TestedHIVPos20_24M
        ("CB6u1gbtcU6", "Zb9bUaVORZI"), // cf_TestedHIVPos25_34M
        ("CB6u1gbtcU6", "jhfPv9e8Oxm"), // cf_TestedHIVPos35_44M
        ("CB6u1gbtcU6", "G2tIjoSOd9v"), // cf_TestedHIVPos45_54M
        ("CB6u1gbtcU6", "ETInBEGRA0Y"), // cf_TestedHIVPos55_64M
        ("CB6u1gbtcU6", "du1eK0zJNtT"), // cf_TestedHIVPos65PlusM
        // HIV+ by age/sex (female)
        ("CB6u1gbtcU6", "nEMa3Ms0Gxf"), // cf_TestedHIVPosU5F
        ("CB6u1gbtcU6", "R0ynuKPdSXA"), // cf_TestedHIVPos5_9F
        ("CB6u1gbtcU6", "WtC6hO05XOb"), // cf_TestedHIVPos10_14F
        ("CB6u1gbtcU6", "uRbNT4CFSyw"), // cf_TestedHIVPos15_19F
        ("CB6u1gbtcU6", "gR1fq5BtlrS"), // cf_TestedHIVPos20_24F
        ("CB6u1gbtcU6", "RJ9POsSy0gn"), // cf_TestedHIVPos25_34F
        ("CB6u1gbtcU6", "NieFs69q88c"), // cf_TestedHIVPos35_44F
        ("CB6u1gbtcU6", "cESPCa8XQh1"), // cf_TestedHIVPos45_54F
        ("CB6u1gbtcU6", "nMBwniCaFKn"), // cf_TestedHIVPos55_64F
        ("CB6u1gbtcU6", "aJP7R1qVIlZ"), // cf_TestedHIVPos65PlusF
        // HIV+ on ART by age/sex (male)
        ("gd7XwnMb3gb", "bPEY7jIIWtU"), // cf_ARTHIVPos0_4M
        ("gd7XwnMb3gb", "viaTEZCdO5b"), // cf_ARTHIVPos5_9M
        ("gd7XwnMb3gb", "b1RYDWtEPVz"), // cf_ARTHIVPos10_14M
        ("gd7XwnMb3gb", "aM6ZmmrjCNn"), // cf_ARTHIVPos15_19M
        ("gd7XwnMb3gb", "ETjoFTNU5w0"), // cf_ARTHIVPos20_24M
        ("gd7XwnMb3gb", "Zb9bUaVORZI"), // cf_ARTHIVPos25_34M
        ("gd7XwnMb3gb", "jhfPv9e8Oxm"), // cf_ARTHIVPos35_44M
        ("gd7XwnMb3gb", "G2tIjoSOd9v"), // cf_ARTHIVPos45_54M
        ("gd7XwnMb3gb", "ETInBEGRA0Y"), // cf_ARTHIVPos55_64M
        ("gd7XwnMb3gb", "du1eK0zJNtT"), // cf_ARTHIVPos65PlusM
        // HIV+ on ART by age/sex (female)
        ("gd7XwnMb3gb", "nEMa3Ms0Gxf"), // cf_ARTHIVPos0_4F
        ("gd7XwnMb3gb", "R0ynuKPdSXA"), // cf_ARTHIVPos5_9F
        ("gd7XwnMb3gb", "WtC6hO05XOb"), // cf_ARTHIVPos10_14F
        ("gd7XwnMb3gb", "uRbNT4CFSyw"), // cf_ARTHIVPos15_19F
        ("gd7XwnMb3gb", "gR1fq5BtlrS"), // cf_ARTHIVPos20_24F
        ("gd7XwnMb3gb", "RJ9POsSy0gn"), // cf_ARTHIVPos25_34F
        ("gd7XwnMb3gb", "NieFs69q88c"), // cf_ARTHIVPos35_44F
        ("gd7XwnMb3gb", "cESPCa8XQh1"), // cf_ARTHIVPos45_54F
        ("gd7XwnMb3gb", "nMBwniCaFKn"), // cf_ARTHIVPos55_64F
        ("gd7XwnMb3gb", "aJP7R1qVIlZ"), // cf_ARTHIVPos65PlusF
        // Sputum conversion (SC period — same dataset)
        ("Wx8MjYmBSh9", "HllvX50cXC0"), // sc_NewPBC
        ("HrjVCXt7YG9", "HllvX50cXC0"), // sc_SmearND
        ("VQWZHr39CD9", "A72XDZTdxk4"), // sc_2Months
        ("VQWZHr39CD9", "Y3zTsMfE6Eo"), // sc_3Months
    };

    /// <summary>
    /// Training/development instance COC IDs — differs from production for the age-band
    /// category option combos used by SOzXMCzgOKB, CB6u1gbtcU6, and gd7XwnMb3gb.
    /// All other slots are identical to CfMapProduction.
    /// </summary>
    private static readonly (string De, string Coc)[] CfMapTraining =
    {
        // Case types (0-11) — same as production
        ("MXPygGMFJyf", "jxFL8f5zw3G"), // cf_PBCNew
        ("MXPygGMFJyf", "dPSjY2kx9EZ"), // cf_PBCRelapse
        ("MXPygGMFJyf", "RTpRZNWomvh"), // cf_PBCPrevTreat
        ("MXPygGMFJyf", "ZSiMF813gUR"), // cf_PBCOther
        ("gBJsPO5Sq4F", "jxFL8f5zw3G"), // cf_PCDNew
        ("gBJsPO5Sq4F", "dPSjY2kx9EZ"), // cf_PCDRelapse
        ("gBJsPO5Sq4F", "RTpRZNWomvh"), // cf_PCDPrevTreat
        ("gBJsPO5Sq4F", "ZSiMF813gUR"), // cf_PCDOther
        ("tLA74ofV37x", "jxFL8f5zw3G"), // cf_EPNew
        ("tLA74ofV37x", "dPSjY2kx9EZ"), // cf_EPRelapse
        ("tLA74ofV37x", "RTpRZNWomvh"), // cf_EPPrevTreat
        ("tLA74ofV37x", "ZSiMF813gUR"), // cf_EPOther
        // New+Relapse by age/sex (male) — COCs differ at 5-9, 10-14, 15-19, 20-24, 65+
        ("SOzXMCzgOKB", "bPEY7jIIWtU"), // cf_PBCNewU5M
        ("SOzXMCzgOKB", "mW0AMc3KCzg"), // cf_PBCNew5_9M    [prod: viaTEZCdO5b]
        ("SOzXMCzgOKB", "mJbNtjYzdPR"), // cf_PBCNew10_14M  [prod: b1RYDWtEPVz]
        ("SOzXMCzgOKB", "OoCqLUvmLW1"), // cf_PBCNew15_19M  [prod: aM6ZmmrjCNn]
        ("SOzXMCzgOKB", "A2x33aXUbT1"), // cf_PBCNew20_24M  [prod: ETjoFTNU5w0]
        ("SOzXMCzgOKB", "Zb9bUaVORZI"), // cf_PBCNew25_34M
        ("SOzXMCzgOKB", "jhfPv9e8Oxm"), // cf_PBCNew35_44M
        ("SOzXMCzgOKB", "G2tIjoSOd9v"), // cf_PBCNew45_54M
        ("SOzXMCzgOKB", "ETInBEGRA0Y"), // cf_PBCNew55_64M
        ("SOzXMCzgOKB", "AXWUlaPC6XK"), // cf_PBCNew65PlusM [prod: du1eK0zJNtT]
        // New+Relapse by age/sex (female) — COCs differ at 5-9, 10-14, 15-19, 20-24, 65+
        ("SOzXMCzgOKB", "nEMa3Ms0Gxf"), // cf_PBCNewU5F
        ("SOzXMCzgOKB", "hVBY1ZuYq62"), // cf_PBCNew5_9F    [prod: R0ynuKPdSXA]
        ("SOzXMCzgOKB", "KUzvTFmXMjb"), // cf_PBCNew10_14F  [prod: WtC6hO05XOb]
        ("SOzXMCzgOKB", "t94iUYiCyxG"), // cf_PBCNew15_19F  [prod: uRbNT4CFSyw]
        ("SOzXMCzgOKB", "EJu2L7zvQBM"), // cf_PBCNew20_24F  [prod: gR1fq5BtlrS]
        ("SOzXMCzgOKB", "RJ9POsSy0gn"), // cf_PBCNew25_34F
        ("SOzXMCzgOKB", "NieFs69q88c"), // cf_PBCNew35_44F
        ("SOzXMCzgOKB", "cESPCa8XQh1"), // cf_PBCNew45_54F
        ("SOzXMCzgOKB", "nMBwniCaFKn"), // cf_PBCNew55_64F
        ("SOzXMCzgOKB", "vO5lSVCfdk7"), // cf_PBCNew65PlusF [prod: aJP7R1qVIlZ]
        // Presumptive cases / lab — same as production
        ("mnTeJKojXDu", "HllvX50cXC0"), // cf_SuspectsSeen
        ("Ga0Uz9Vd2ed", "HllvX50cXC0"), // cf_PBCLab
        // HIV activities — same as production
        ("Xnfuc0bReo2", "RXgmEQPmgKK"), // cf_TestedHIV
        ("Xnfuc0bReo2", "tznO3ytAWWP"), // cf_TestedHIVPos
        ("Xnfuc0bReo2", "x7us62aFEjK"), // cf_TestedHIVART
        ("Xnfuc0bReo2", "iSs98SgDs8O"), // cf_TestedHIVCPT
        // Diagnostic methods used — same as production
        ("Ui132KQgN1v", "XYWUL2edkCw"), // cf_GeneXpert
        ("Ui132KQgN1v", "gPRbmWmNtyN"), // cf_Microscopy
        ("Ui132KQgN1v", "kz1iKOYuQli"), // cf_TBLam
        ("Ui132KQgN1v", "vsHgzpLJKkR"), // cf_TrueNat
        ("Ui132KQgN1v", "F13nzEEGFk0"), // cf_Xray
        // Positive results by method — same as production
        ("FldClHDZoNn", "XYWUL2edkCw"), // cf_GeneXpert_Pos
        ("FldClHDZoNn", "gPRbmWmNtyN"), // cf_Microscopy_Pos
        ("FldClHDZoNn", "kz1iKOYuQli"), // cf_TBLam_Pos
        ("FldClHDZoNn", "vsHgzpLJKkR"), // cf_TrueNat_Pos
        ("FldClHDZoNn", "F13nzEEGFk0"), // cf_Xray_Pos
        // HIV+ by age/sex (male) — COCs differ at 5-9, 10-14, 15-19, 20-24, 65+
        ("CB6u1gbtcU6", "bPEY7jIIWtU"), // cf_TestedHIVPosU5M
        ("CB6u1gbtcU6", "mW0AMc3KCzg"), // cf_TestedHIVPos5_9M    [prod: viaTEZCdO5b]
        ("CB6u1gbtcU6", "OoCqLUvmLW1"), // cf_TestedHIVPos10_14M  [prod: b1RYDWtEPVz]
        ("CB6u1gbtcU6", "A2x33aXUbT1"), // cf_TestedHIVPos15_19M  [prod: aM6ZmmrjCNn]
        ("CB6u1gbtcU6", "DRkgg4kVdYA"), // cf_TestedHIVPos20_24M  [prod: ETjoFTNU5w0]
        ("CB6u1gbtcU6", "Zb9bUaVORZI"), // cf_TestedHIVPos25_34M
        ("CB6u1gbtcU6", "jhfPv9e8Oxm"), // cf_TestedHIVPos35_44M
        ("CB6u1gbtcU6", "G2tIjoSOd9v"), // cf_TestedHIVPos45_54M
        ("CB6u1gbtcU6", "ETInBEGRA0Y"), // cf_TestedHIVPos55_64M
        ("CB6u1gbtcU6", "AXWUlaPC6XK"), // cf_TestedHIVPos65PlusM [prod: du1eK0zJNtT]
        // HIV+ by age/sex (female) — COCs differ at 5-9, 10-14, 15-19, 20-24, 65+
        ("CB6u1gbtcU6", "nEMa3Ms0Gxf"), // cf_TestedHIVPosU5F
        ("CB6u1gbtcU6", "hVBY1ZuYq62"), // cf_TestedHIVPos5_9F    [prod: R0ynuKPdSXA]
        ("CB6u1gbtcU6", "KUzvTFmXMjb"), // cf_TestedHIVPos10_14F  [prod: WtC6hO05XOb]
        ("CB6u1gbtcU6", "t94iUYiCyxG"), // cf_TestedHIVPos15_19F  [prod: uRbNT4CFSyw]
        ("CB6u1gbtcU6", "EJu2L7zvQBM"), // cf_TestedHIVPos20_24F  [prod: gR1fq5BtlrS]
        ("CB6u1gbtcU6", "RJ9POsSy0gn"), // cf_TestedHIVPos25_34F
        ("CB6u1gbtcU6", "NieFs69q88c"), // cf_TestedHIVPos35_44F
        ("CB6u1gbtcU6", "cESPCa8XQh1"), // cf_TestedHIVPos45_54F
        ("CB6u1gbtcU6", "nMBwniCaFKn"), // cf_TestedHIVPos55_64F
        ("CB6u1gbtcU6", "vO5lSVCfdk7"), // cf_TestedHIVPos65PlusF [prod: aJP7R1qVIlZ]
        // HIV+ on ART by age/sex (male) — COCs differ at 5-9, 10-14, 15-19, 20-24, 65+
        ("gd7XwnMb3gb", "bPEY7jIIWtU"), // cf_ARTHIVPos0_4M
        ("gd7XwnMb3gb", "mW0AMc3KCzg"), // cf_ARTHIVPos5_9M    [prod: viaTEZCdO5b]
        ("gd7XwnMb3gb", "mJbNtjYzdPR"), // cf_ARTHIVPos10_14M  [prod: b1RYDWtEPVz]
        ("gd7XwnMb3gb", "OoCqLUvmLW1"), // cf_ARTHIVPos15_19M  [prod: aM6ZmmrjCNn]
        ("gd7XwnMb3gb", "EJu2L7zvQBM"), // cf_ARTHIVPos20_24M  [prod: ETjoFTNU5w0]
        ("gd7XwnMb3gb", "Zb9bUaVORZI"), // cf_ARTHIVPos25_34M
        ("gd7XwnMb3gb", "jhfPv9e8Oxm"), // cf_ARTHIVPos35_44M
        ("gd7XwnMb3gb", "G2tIjoSOd9v"), // cf_ARTHIVPos45_54M
        ("gd7XwnMb3gb", "ETInBEGRA0Y"), // cf_ARTHIVPos55_64M
        ("gd7XwnMb3gb", "AXWUlaPC6XK"), // cf_ARTHIVPos65PlusM [prod: du1eK0zJNtT]
        // HIV+ on ART by age/sex (female) — COCs differ at 5-9, 10-14, 15-19, 20-24, 65+
        ("gd7XwnMb3gb", "nEMa3Ms0Gxf"), // cf_ARTHIVPos0_4F
        ("gd7XwnMb3gb", "hVBY1ZuYq62"), // cf_ARTHIVPos5_9F    [prod: R0ynuKPdSXA]
        ("gd7XwnMb3gb", "KUzvTFmXMjb"), // cf_ARTHIVPos10_14F  [prod: WtC6hO05XOb]
        ("gd7XwnMb3gb", "t94iUYiCyxG"), // cf_ARTHIVPos15_19F  [prod: uRbNT4CFSyw]
        ("gd7XwnMb3gb", "EJu2L7zvQBM"), // cf_ARTHIVPos20_24F  [prod: gR1fq5BtlrS]
        ("gd7XwnMb3gb", "RJ9POsSy0gn"), // cf_ARTHIVPos25_34F
        ("gd7XwnMb3gb", "NieFs69q88c"), // cf_ARTHIVPos35_44F
        ("gd7XwnMb3gb", "cESPCa8XQh1"), // cf_ARTHIVPos45_54F
        ("gd7XwnMb3gb", "nMBwniCaFKn"), // cf_ARTHIVPos55_64F
        ("gd7XwnMb3gb", "vO5lSVCfdk7"), // cf_ARTHIVPos65PlusF [prod: aJP7R1qVIlZ]
        // Sputum conversion — same as production
        ("Wx8MjYmBSh9", "HllvX50cXC0"), // sc_NewPBC
        ("HrjVCXt7YG9", "HllvX50cXC0"), // sc_SmearND
        ("VQWZHr39CD9", "A72XDZTdxk4"), // sc_2Months
        ("VQWZHr39CD9", "Y3zTsMfE6Eo"), // sc_3Months
    };

    private static readonly (string De, string Coc)[] ToMap =
    {
        // New PBC (Bacteriologically confirmed) outcomes by sex
        ("NnVXDC6BisM", "EjEaUZh0mIC"), // to_NewPBCM
        ("NnVXDC6BisM", "ANE73NCZRLU"), // to_NewPBCF
        ("NnVXDC6BisM", "sJ8CCN27SRc"), // to_NewPBC_CuredM
        ("NnVXDC6BisM", "GUynpeAu1ys"), // to_NewPBC_CuredF
        ("NnVXDC6BisM", "ptkWjL8ZsQi"), // to_NewPBC_CompletedM
        ("NnVXDC6BisM", "rmKdVF1p6Y1"), // to_NewPBC_CompletedF
        ("NnVXDC6BisM", "VCCaxjlVFkZ"), // to_NewPBC_DiedM
        ("NnVXDC6BisM", "nH6GP66RAtJ"), // to_NewPBC_DiedF
        ("NnVXDC6BisM", "Qm8GG10mhFJ"), // to_NewPBC_FailedM
        ("NnVXDC6BisM", "qKULnRmurHT"), // to_NewPBC_FailedF
        ("NnVXDC6BisM", "fvWMkcVVMNS"), // to_NewPBC_LostToFPM
        ("NnVXDC6BisM", "bKTzWce88Nb"), // to_NewPBC_LostToFPF
        ("NnVXDC6BisM", "k96miXPlAEG"), // to_NewPBC_NotEvalM
        ("NnVXDC6BisM", "NTYvuTpfDEj"), // to_NewPBC_NotEvalF
        // New PCD/EP outcomes by sex
        ("WosZoWkjAo6", "EjEaUZh0mIC"), // to_NewPCDEPM
        ("WosZoWkjAo6", "ANE73NCZRLU"), // to_NewPCDEPF
        ("WosZoWkjAo6", "ptkWjL8ZsQi"), // to_NewPCDEP_CompletedM
        ("WosZoWkjAo6", "rmKdVF1p6Y1"), // to_NewPCDEP_CompletedF
        ("WosZoWkjAo6", "VCCaxjlVFkZ"), // to_NewPCDEP_DiedM
        ("WosZoWkjAo6", "nH6GP66RAtJ"), // to_NewPCDEP_DiedF
        ("WosZoWkjAo6", "Qm8GG10mhFJ"), // to_NewPCDEP_FailedM
        ("WosZoWkjAo6", "qKULnRmurHT"), // to_NewPCDEP_FailedF
        ("WosZoWkjAo6", "fvWMkcVVMNS"), // to_NewPCDEP_LostToFPM
        ("WosZoWkjAo6", "bKTzWce88Nb"), // to_NewPCDEP_LostToFPF
        ("WosZoWkjAo6", "k96miXPlAEG"), // to_NewPCDEP_NotEvalM
        ("WosZoWkjAo6", "NTYvuTpfDEj"), // to_NewPCDEP_NotEvalF
        // Relapse outcomes by sex
        ("kVbQml7P5G7", "EjEaUZh0mIC"), // to_RelapseM
        ("kVbQml7P5G7", "ANE73NCZRLU"), // to_RelapseF
        ("kVbQml7P5G7", "sJ8CCN27SRc"), // to_Relapse_CuredM
        ("kVbQml7P5G7", "GUynpeAu1ys"), // to_Relapse_CuredF
        ("kVbQml7P5G7", "ptkWjL8ZsQi"), // to_Relapse_CompletedM
        ("kVbQml7P5G7", "rmKdVF1p6Y1"), // to_Relapse_CompletedF
        ("kVbQml7P5G7", "VCCaxjlVFkZ"), // to_Relapse_DiedM
        ("kVbQml7P5G7", "nH6GP66RAtJ"), // to_Relapse_DiedF
        ("kVbQml7P5G7", "Qm8GG10mhFJ"), // to_Relapse_FailedM
        ("kVbQml7P5G7", "qKULnRmurHT"), // to_Relapse_FailedF
        ("kVbQml7P5G7", "fvWMkcVVMNS"), // to_Relapse_LostToFPM
        ("kVbQml7P5G7", "bKTzWce88Nb"), // to_Relapse_LostToFPF
        ("kVbQml7P5G7", "k96miXPlAEG"), // to_Relapse_NotEvalM
        ("kVbQml7P5G7", "NTYvuTpfDEj"), // to_Relapse_NotEvalF
        // Previously treated — After Failure
        ("gZFINTNgvlN", "Lhru44pCaDo"), // to_Failure
        ("gZFINTNgvlN", "gtZd9r6RbAB"), // to_Failure_Cured
        ("VLPmpYJ9N89", "uA8adFPlOqg"), // to_Failure_Completed (different DE — matches original)
        ("gZFINTNgvlN", "RgghjfcxA9n"), // to_Failure_Died
        ("gZFINTNgvlN", "HU0eLqEEzvy"), // to_Failure_Failed
        ("gZFINTNgvlN", "x21jiHcqvrb"), // to_Failure_LostToFP
        ("gZFINTNgvlN", "frZDf6pRHOk"), // to_Failure_NotEval
        // Treatment Interrupted (Lost to Follow-up prior to treatment)
        ("T3EcBx06nK1", "Lhru44pCaDo"), // to_LostToFP
        ("T3EcBx06nK1", "gtZd9r6RbAB"), // to_LostToFP_Cured
        ("T3EcBx06nK1", "HU0eLqEEzvy"), // to_LostToFP_Completed
        ("T3EcBx06nK1", "RgghjfcxA9n"), // to_LostToFP_Died
        ("T3EcBx06nK1", "uA8adFPlOqg"), // to_LostToFP_Failed
        ("T3EcBx06nK1", "x21jiHcqvrb"), // to_LostToFP_LostToFP
        ("T3EcBx06nK1", "frZDf6pRHOk"), // to_LostToFP_NotEval
        // Other
        ("m1hibtcEogD", "Lhru44pCaDo"), // to_Other
        ("m1hibtcEogD", "gtZd9r6RbAB"), // to_Other_Cured
        ("m1hibtcEogD", "HU0eLqEEzvy"), // to_Other_Completed
        ("m1hibtcEogD", "RgghjfcxA9n"), // to_Other_Died
        ("m1hibtcEogD", "uA8adFPlOqg"), // to_Other_Failed
        ("m1hibtcEogD", "x21jiHcqvrb"), // to_Other_LostToFP
        ("m1hibtcEogD", "frZDf6pRHOk"), // to_Other_NotEval
        // HIV/TB activities (outcome period)
        ("CUXB3BXTLTj", "ELoDV4C3Rha"), // to_TestedHIV
        ("CUXB3BXTLTj", "aLsVUwrAbOT"), // to_TestedHIVPos
        ("CUXB3BXTLTj", "K8kmJM8JT2k"), // to_TestedHIVART
        ("CUXB3BXTLTj", "alUo29qSMm5"), // to_TestedHIVCPT
        // HIV-positive outcomes
        ("OBxOcDrbThw", "Lhru44pCaDo"), // to_TestedHIVPos (used again as total HIV+)
        ("OBxOcDrbThw", "gtZd9r6RbAB"), // to_HIVPos_Cured
        ("OBxOcDrbThw", "HU0eLqEEzvy"), // to_HIVPos_Completed
        ("OBxOcDrbThw", "RgghjfcxA9n"), // to_HIVPos_Died
        ("OBxOcDrbThw", "uA8adFPlOqg"), // to_HIVPos_Failed
        ("OBxOcDrbThw", "x21jiHcqvrb"), // to_HIVPos_LostToFP
        ("OBxOcDrbThw", "frZDf6pRHOk"), // to_HIVPos_NotEval
        // Children (<15 years)
        ("tT48uxulUNU", "Lhru44pCaDo"), // to_Chn
        ("tT48uxulUNU", "gtZd9r6RbAB"), // to_Chn_Cured
        ("tT48uxulUNU", "HU0eLqEEzvy"), // to_Chn_Completed
        ("tT48uxulUNU", "RgghjfcxA9n"), // to_Chn_Died
        ("tT48uxulUNU", "uA8adFPlOqg"), // to_Chn_Failed
        ("tT48uxulUNU", "x21jiHcqvrb"), // to_Chn_LostToFP
        ("tT48uxulUNU", "frZDf6pRHOk"), // to_Chn_NotEval
        // Adolescents (10-19 years)
        ("f8GsGY3Qm7V", "Lhru44pCaDo"), // to_Adol
        ("f8GsGY3Qm7V", "gtZd9r6RbAB"), // to_Adol_Cured
        ("f8GsGY3Qm7V", "HU0eLqEEzvy"), // to_Adol_Completed
        ("f8GsGY3Qm7V", "RgghjfcxA9n"), // to_Adol_Died
        ("f8GsGY3Qm7V", "uA8adFPlOqg"), // to_Adol_Failed
        ("f8GsGY3Qm7V", "x21jiHcqvrb"), // to_Adol_LostToFP
        ("f8GsGY3Qm7V", "frZDf6pRHOk"), // to_Adol_NotEval
    };

    /// <summary>
    /// Returns the correct CfMap for the configured DHIS2 instance.
    /// Training and production instances use different category option combo UIDs
    /// for the age-band disaggregations of SOzXMCzgOKB, CB6u1gbtcU6, and gd7XwnMb3gb.
    /// </summary>
    private (string De, string Coc)[] ActiveCfMap =>
        _config.GetValue<bool>("Dhis2:UseTraining", true) ? CfMapTraining : CfMapProduction;

    // ── Internal cache types ──────────────────────────────────────────────────

    /// <summary>One facility's computed report data, stored in IMemoryCache.</summary>
    private sealed class FacilityCache
    {
        public required string Uid          { get; set; }
        public required string FacilityName { get; set; }
        public required string County       { get; set; }
        public required string State        { get; set; }
        public required string StateShort   { get; set; }
        public required int    FacilityId   { get; set; }
        public required string Period       { get; set; }  // DHIS2 format: "2026Q1"
        public required int    CfQuarter    { get; set; }
        public required int    CfYear       { get; set; }
        public required int    ScQuarter    { get; set; }
        public required int    ScYear       { get; set; }
        public required int    ToQuarter    { get; set; }
        public required int    ToYear       { get; set; }
        public required int[]  CfValues     { get; set; }  // parallel to CfMap
        public required int[]  ToValues     { get; set; }  // parallel to ToMap
    }

    // ── SSE / cache helpers ───────────────────────────────────────────────────
    private sealed record Dhis2CacheEntry(byte[] Bytes, string Filename);
    private static readonly JsonSerializerOptions SseJsonOptions =
        new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    // ── DI fields ─────────────────────────────────────────────────────────────

    private readonly string              _connectionString;
    private readonly IConfiguration      _config;
    private readonly ILogger<Dhis2Controller> _logger;
    private readonly IWebHostEnvironment _env;
    private readonly IMemoryCache        _cache;
    private readonly IHttpClientFactory  _httpFactory;

    public Dhis2Controller(
        IConfiguration config,
        ILogger<Dhis2Controller> logger,
        IWebHostEnvironment env,
        IMemoryCache cache,
        IHttpClientFactory httpFactory)
    {
        _connectionString = config.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("DefaultConnection is not configured.");
        _config      = config;
        _logger      = logger;
        _env         = env;
        _cache       = cache;
        _httpFactory = httpFactory;
    }

    // =========================================================================
    //  GET /api/dhis2/tb-prepare
    // =========================================================================
    /// <summary>
    /// Computes quarterly TB report data for all facilities accessible to the
    /// current user, caches the results, and returns the facility list for the
    /// "Select Reports to Send to DHIS2" UI.
    ///
    /// Query params:
    ///   cfQuarter, cfYear   — Case Finding period  (required)
    ///   scQuarter, scYear   — Sputum Conversion period (optional; defaults to CF-1, i.e. the quarter immediately before CF)
    ///   toQuarter, toYear   — Treatment Outcome period (optional; defaults to CF-4, i.e. exactly one year before CF)
    /// </summary>
    [HttpGet("tb-prepare")]
    public async Task<IActionResult> Prepare([FromQuery] TbPrepareQuery q)
    {
        if (q.CfQuarter is < 1 or > 4)
            return BadRequest(new { error = "cfQuarter must be 1–4." });
        if (q.CfYear is < 2000 or > 2100)
            return BadRequest(new { error = "cfYear is out of range." });

        // Resolve SC and TO periods with defaults
        // SC = one quarter immediately before CF (offset -1)
        // TO = exactly one year before CF        (offset -4)
        var (scQ, scY) = q.ScQuarter.HasValue
            ? (q.ScQuarter.Value, q.ScYear!.Value)
            : ShiftQuarter(q.CfQuarter, q.CfYear, -1);

        var (toQ, toY) = q.ToQuarter.HasValue
            ? (q.ToQuarter.Value, q.ToYear!.Value)
            : ShiftQuarter(q.CfQuarter, q.CfYear, -4);

        var (cfStart, cfEnd) = QuarterDates(q.CfQuarter, q.CfYear);
        var (scStart, scEnd) = QuarterDates(scQ, scY);
        var (toStart, toEnd) = QuarterDates(toQ, toY);

        string period   = $"{q.CfYear}Q{q.CfQuarter}";
        string userId   = User.FindFirstValue("user_id") ?? "0";
        string cacheKey = $"dhis2_tb_{userId}_{q.CfQuarter}_{q.CfYear}_{scQ}_{scY}_{toQ}_{toY}";

        // Get scope from JWT claims
        int.TryParse(User.FindFirstValue("facility_id"), out var facilityId);
        int.TryParse(User.FindFirstValue("county_id"),   out var countyId);
        int.TryParse(User.FindFirstValue("state_id"),    out var stateId);
        int.TryParse(User.FindFirstValue("is_super_user"), out var isSuperUser);

        try
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // ── Get accessible facilities ─────────────────────────────────────
            var facilities = await GetFacilitiesInScopeAsync(
                conn, facilityId, countyId, stateId, isSuperUser == 1);

            if (facilities.Count == 0)
                return Ok(new { facilities = Array.Empty<FacilityReportDto>(), cacheKey });

            // ── Compute data per facility ─────────────────────────────────────
            var cacheDict = new Dictionary<string, FacilityCache>(StringComparer.Ordinal);
            var result    = new List<FacilityReportDto>();

            foreach (var fac in facilities)
            {
                if (string.IsNullOrWhiteSpace(fac.Uid)) continue;

                var (cfVals, toVals) = await ComputeFacilityAsync(
                    conn, fac.FacilityId,
                    cfStart, cfEnd,
                    scStart, scEnd,
                    toStart, toEnd);

                int totalCf = cfVals.Sum();
                int totalTo = toVals.Sum();

                // Only include facilities that have any data
                if (totalCf == 0 && totalTo == 0) continue;

                var entry = new FacilityCache
                {
                    Uid          = fac.Uid,
                    FacilityName = fac.FacilityName,
                    County       = fac.County,
                    State        = fac.State,
                    StateShort   = fac.StateShort,
                    FacilityId   = fac.FacilityId,
                    Period       = period,
                    CfQuarter    = q.CfQuarter,
                    CfYear       = q.CfYear,
                    ScQuarter    = scQ,
                    ScYear       = scY,
                    ToQuarter    = toQ,
                    ToYear       = toY,
                    CfValues     = cfVals,
                    ToValues     = toVals,
                };

                cacheDict[fac.Uid] = entry;
                result.Add(new FacilityReportDto(
                    fac.Uid,
                    fac.FacilityName,
                    fac.County,
                    fac.State,
                    fac.StateShort,
                    $"Q{q.CfQuarter} {q.CfYear}",
                    totalCf,
                    totalTo));
            }

            // Cache for 60 minutes — covers the time between prepare and send
            _cache.Set(cacheKey, cacheDict,
                new MemoryCacheEntryOptions { SlidingExpiration = TimeSpan.FromMinutes(60) });

            return Ok(new { facilities = result, cacheKey });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in tb-prepare for user {UserId}", userId);
            return StatusCode(500, new { error = "An internal error occurred generating the report data." });
        }
    }

    // =========================================================================
    //  GET /api/dhis2/tb-preview
    // =========================================================================
    /// <summary>
    /// Exports one facility's computed data to the NTP Excel template for
    /// visual verification before submitting to DHIS2.
    /// Only one facility at a time (same restriction as original system).
    /// </summary>
    [HttpGet("tb-preview")]
    public IActionResult Preview(
        [FromQuery] string uid,
        [FromQuery] string cacheKey)
    {
        if (string.IsNullOrWhiteSpace(uid) || string.IsNullOrWhiteSpace(cacheKey))
            return BadRequest(new { error = "uid and cacheKey are required." });

        if (!_cache.TryGetValue<Dictionary<string, FacilityCache>>(cacheKey, out var cacheDict)
            || cacheDict is null)
            return BadRequest(new { error = "Session expired. Please re-run Prepare." });

        if (!cacheDict.TryGetValue(uid, out var fac))
            return NotFound(new { error = "Facility not found in current report session." });

        string templatePath = Path.Combine(
            _env.ContentRootPath, "Templates", "Template_DSTB_NTP_Report.xlsx");

        if (!System.IO.File.Exists(templatePath))
            return StatusCode(500, new { error = "NTP report template not found on server." });

        try
        {
            var wb = new XLWorkbook(templatePath);
            FillCaseFindingSheet(wb, fac);
            FillSputumConversionSheet(wb, fac);
            FillTreatmentOutcomeSheet(wb, fac);

            using var ms = new MemoryStream();
            wb.SaveAs(ms);
            ms.Position = 0;

            string filename = $"{fac.FacilityName.Replace(" ", "_")}_TB_NTP_Preview" +
                              $"_Q{fac.CfQuarter}_{fac.CfYear}_SV.xlsx";
            filename = string.Concat(filename.Where(c => c != '"' && c != '\\' && c != '/'));

            return File(ms.ToArray(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                filename);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error generating preview for {Uid}", uid);
            return StatusCode(500, new { error = "Error generating Excel preview." });
        }
    }

    // =========================================================================
    //  GET /api/dhis2/tb-dump  (TEMPORARY DEBUG ENDPOINT)
    // =========================================================================
    /// <summary>
    /// Returns the full raw CfValues / ToValues arrays for every cached facility
    /// as labelled JSON for inspection before sending. Non-zero entries include
    /// the slot index, dataElement UID, COC UID, and computed value. Zero entries
    /// are omitted unless ?includeZero=true is passed.
    /// </summary>
    [HttpGet("tb-dump")]
    public IActionResult Dump([FromQuery] string cacheKey, [FromQuery] bool includeZero = false)
    {
        if (string.IsNullOrWhiteSpace(cacheKey))
            return BadRequest(new { error = "cacheKey is required." });

        if (!_cache.TryGetValue<Dictionary<string, FacilityCache>>(cacheKey, out var cacheDict)
            || cacheDict is null)
            return BadRequest(new { error = "Session expired or not found. Please re-run Prepare." });

        static object[] ToSlots((string De, string Coc)[] map, int[] vals, bool allSlots) =>
            map.Select((m, i) => (m, i, vals[i]))
               .Where(x => allSlots || x.Item3 != 0)
               .Select(x => (object)new { slot = x.i, de = x.m.De, coc = x.m.Coc, value = x.Item3 })
               .ToArray();

        var facilities = cacheDict.Values.Select(fac => new
        {
            uid          = fac.Uid,
            facilityName = fac.FacilityName,
            county       = fac.County,
            state        = fac.State,
            stateShort   = fac.StateShort,
            period       = fac.Period,
            cfPeriod     = $"Q{fac.CfQuarter} {fac.CfYear}",
            scPeriod     = $"Q{fac.ScQuarter} {fac.ScYear}",
            toPeriod     = $"Q{fac.ToQuarter} {fac.ToYear}",
            cfSlots      = ToSlots(ActiveCfMap, fac.CfValues, includeZero),
            toSlots      = ToSlots(ToMap, fac.ToValues, includeZero),
            cfRaw        = fac.CfValues,
            toRaw        = fac.ToValues,
        }).OrderBy(f => f.facilityName).ToArray();

        return Ok(new
        {
            generatedAt     = DateTime.UtcNow,
            includeZero,
            facilityCount   = facilities.Length,
            cfSlotCount     = ActiveCfMap.Length,
            toSlotCount     = ToMap.Length,
            facilities,
        });
    }

    // =========================================================================
    //  GET /api/dhis2/tb-read-ntp
    // =========================================================================
    /// <summary>
    /// Streams SSE progress events while fetching aggregate TB report data from
    /// DHIS2 for the selected facilities and periods, then builds the NTP Excel
    /// workbook.  On completion emits a download token; the client then calls
    /// tb-read-ntp-download to retrieve the file.
    ///
    /// Query params:
    ///   periods       — one or more DHIS2 period strings in "YYYYQn" format,
    ///                   e.g. periods=2026Q1&amp;periods=2026Q2 (required).
    ///                   Data for all periods is summed before filling the template.
    ///   facilityIds   — one or more HealthFacilityID values (required)
    ///
    /// Geographic permissions are enforced: only facilities within the user's
    /// JWT scope are queried, even if the caller passes additional facility IDs.
    /// </summary>
    [HttpGet("tb-read-ntp")]
    public async Task ReadNtpFromDhis2(
        [FromQuery] List<string> periods,
        [FromQuery] List<int> facilityIds)
    {
        var ct = HttpContext.RequestAborted;

        // ── Input validation (before SSE headers are sent) ───────────────
        if (periods is null || periods.Count == 0)
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "At least one period is required." }); return; }
        if (facilityIds is null || facilityIds.Count == 0)
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "No facilities selected." }); return; }

        // Parse and validate each period (must be "YYYYQn" format)
        var periodRegex = new System.Text.RegularExpressions.Regex(@"^(\d{4})Q([1-4])$",
            System.Text.RegularExpressions.RegexOptions.None);
        var parsedPeriods = new List<(int Quarter, int Year, string Raw)>(periods.Count);
        foreach (var raw in periods)
        {
            var m = periodRegex.Match(raw ?? "");
            if (!m.Success)
            { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = $"Invalid period '{raw}'. Expected format: YYYYQn (e.g. 2026Q1)." }); return; }
            int y = int.Parse(m.Groups[1].Value);
            int q = int.Parse(m.Groups[2].Value);
            if (y is < 2000 or > 2100)
            { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = $"Period year '{y}' is out of range." }); return; }
            parsedPeriods.Add((q, y, raw!));
        }

        // Derive CF header values from the LAST (most recent) period in the list
        var lastPeriod = parsedPeriods[^1];
        int quarter    = lastPeriod.Quarter;
        int year       = lastPeriod.Year;

        // Get user scope from JWT
        int.TryParse(User.FindFirstValue("facility_id"),   out var facilityId);
        int.TryParse(User.FindFirstValue("county_id"),     out var countyId);
        int.TryParse(User.FindFirstValue("state_id"),      out var stateId);
        int.TryParse(User.FindFirstValue("is_super_user"), out var isSuperUser);

        // DHIS2 credentials
        bool   useTraining = _config.GetValue<bool>("Dhis2:UseTraining", true);
        string section     = useTraining ? "Dhis2:Training" : "Dhis2:Production";
        string dhisBaseUrl = (_config[$"{section}:Url"] ?? string.Empty).TrimEnd('/');
        string dhisUser    = _config[$"{section}:Username"] ?? string.Empty;
        string dhisPwd     = _config[$"{section}:Password"] ?? string.Empty;

        if (string.IsNullOrWhiteSpace(dhisBaseUrl))
        { Response.StatusCode = 500; await Response.WriteAsJsonAsync(new { error = "DHIS2 URL is not configured." }); return; }

        // Resolve facilities before switching to SSE so early errors return clean JSON
        List<FacilityRow> selectedFacilities;
        List<string>      uids;
        try
        {
            await using var connCheck = new SqlConnection(_connectionString);
            await connCheck.OpenAsync(ct);
            var scopeFacilities = await GetFacilitiesInScopeAsync(
                connCheck, facilityId, countyId, stateId, isSuperUser == 1);
            selectedFacilities = scopeFacilities
                .Where(f => facilityIds.Contains(f.FacilityId)).ToList();
            if (selectedFacilities.Count == 0)
            { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "No accessible facilities match the selection." }); return; }
            uids = selectedFacilities
                .Where(f => !string.IsNullOrWhiteSpace(f.Uid))
                .Select(f => f.Uid!).Distinct().ToList();
            if (uids.Count == 0)
            { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "None of the selected facilities have DHIS2 UIDs configured." }); return; }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error resolving facilities in tb-read-ntp");
            Response.StatusCode = 500;
            await Response.WriteAsJsonAsync(new { error = "Failed to resolve facility list." });
            return;
        }

        // ── SSE response setup ────────────────────────────────────────────
        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.Append("Cache-Control", "no-cache, no-store");
        Response.Headers.Append("X-Accel-Buffering", "no");
        HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        const int totalSteps = 4;
        int step = 0;

        async Task Emit(object payload)
        {
            var json = JsonSerializer.Serialize(payload, SseJsonOptions);
            await Response.WriteAsync($"data: {json}\n\n", ct);
            await Response.Body.FlushAsync(ct);
        }

        async Task Progress(string label)
        {
            step++;
            await Emit(new { step, total = totalSteps, label });
        }

        try
        {
            // SC/TO quarter offsets are derived from the LAST (CF) period for Excel header labels.
            // When multiple periods are requested, data is summed across all periods; headers
            // reflect the most recent quarter in the range.
            var (scQ, scY) = ShiftQuarter(quarter, year, -1); // for Excel headers only
            var (toQ, toY) = ShiftQuarter(quarter, year, -4); // for Excel headers only

            // Build multi-period URL fragment: period=2026Q1&period=2026Q2 …
            string periodParams = string.Join("&",
                parsedPeriods.Select(p => $"period={Uri.EscapeDataString(p.Raw)}"));

            // Build HTTP client with DHIS2 Basic Auth
            var httpClient = _httpFactory.CreateClient("dhis2");
            var authBytes  = Encoding.ASCII.GetBytes($"{dhisUser}:{dhisPwd}");
            httpClient.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Basic", Convert.ToBase64String(authBytes));

            string ouParams = string.Join("&",
                uids.Select(u => $"orgUnit={Uri.EscapeDataString(u)}"));

            var cfAgg = new Dictionary<(string De, string Coc), int>(capacity: 200);
            var toAgg = new Dictionary<(string De, string Coc), int>(capacity: 120);

            // Step 1 — Fetch Case Finding + Sputum Conversion data
            // (both are in CfDataSet; all requested periods fetched in one call,
            //  DHIS2 returns values for each period separately which FetchAndAggregateAsync sums)
            await Progress("Fetching Case Finding & Sputum Conversion data from DHIS2\u2026");
            await FetchAndAggregateAsync(httpClient,
                $"{dhisBaseUrl}?dataSet={CfDataSet}&{periodParams}&{ouParams}&children=false",
                cfAgg);

            // Step 2 — (no separate SC fetch needed — SC elements are in cfAgg above)
            await Progress("Fetching Sputum Conversion data from DHIS2\u2026");
            // SC data elements are already in cfAgg (same CfDataSet, same period params)

            // Step 3 — Fetch Treatment Outcome data (ToDataSet, same period params)
            await Progress("Fetching Treatment Outcome data from DHIS2\u2026");
            await FetchAndAggregateAsync(httpClient,
                $"{dhisBaseUrl}?dataSet={ToDataSet}&{periodParams}&{ouParams}&children=false",
                toAgg);

            // Step 4 — Build Excel workbook
            await Progress("Building Excel report\u2026");

            var cfMap = ActiveCfMap;
            int[] cfVals = new int[cfMap.Length];
            // CF and SC values all come from cfAgg (same dataset, same periods in DHIS2)
            for (int i = 0; i < cfMap.Length; i++)
                cfAgg.TryGetValue((cfMap[i].De, cfMap[i].Coc), out cfVals[i]);

            int[] toVals = new int[ToMap.Length];
            for (int i = 0; i < ToMap.Length; i++)
                toAgg.TryGetValue((ToMap[i].De, ToMap[i].Coc), out toVals[i]);

            string geoLabel;
            if (selectedFacilities.Count == 1)
            {
                geoLabel = selectedFacilities[0].FacilityName;
            }
            else
            {
                var distinctCounties = selectedFacilities.Select(f => f.County).Distinct().ToList();
                geoLabel = distinctCounties.Count == 1
                    ? distinctCounties[0]
                    : selectedFacilities[0].State;
            }

            // Period label used in FacilityCache.Period and the Excel filename
            string periodLabel = parsedPeriods.Count == 1
                ? parsedPeriods[0].Raw
                : $"{parsedPeriods[0].Raw}-{lastPeriod.Raw}";

            var aggregated = new FacilityCache
            {
                Uid          = "aggregate",
                FacilityName = geoLabel,
                County       = selectedFacilities[0].County,
                State        = selectedFacilities[0].State,
                StateShort   = selectedFacilities[0].StateShort,
                FacilityId   = 0,
                Period       = periodLabel,
                CfQuarter    = quarter,
                CfYear       = year,
                ScQuarter    = scQ,
                ScYear       = scY,
                ToQuarter    = toQ,
                ToYear       = toY,
                CfValues     = cfVals,
                ToValues     = toVals,
            };

            string templatePath = Path.Combine(
                _env.ContentRootPath, "Templates", "Template_DSTB_NTP_Report.xlsx");
            if (!System.IO.File.Exists(templatePath))
            { await Emit(new { error = "NTP report template not found on server." }); return; }

            var wb = new XLWorkbook(templatePath);
            FillCaseFindingSheet(wb, aggregated);
            FillSputumConversionSheet(wb, aggregated);
            FillTreatmentOutcomeSheet(wb, aggregated);

            // Treatment outcome summary sheet: Q8 = TO year (matches '4-Treatment outcome'!W8)
            if (wb.Worksheets.Count >= 5)
            {
                var ws5 = wb.Worksheets.Worksheet(5);
                ws5.Cell("D8").SetValue(geoLabel);
                ws5.Cell("M8").SetValue(quarter.ToString());
                ws5.Cell("Q8").SetValue(toY.ToString());
                ws5.Cell("M9").SetValue(DateTime.Now.ToString("dd/MM/yyyy"));
            }

            // ── Multi-period: patch header cells to show the full quarter range ─
            // e.g. H1 2026 → CF quarter = "1 and 2", SC quarter = "3 and 4" (2025), etc.
            // These cells are text so any string is valid.
            if (parsedPeriods.Count > 1)
            {
                int n = parsedPeriods.Count;

                string cfQLabel = FormatQuarterList(parsedPeriods.Select(p => p.Quarter).ToList());
                string cfYLabel = parsedPeriods[0].Year == parsedPeriods[^1].Year
                    ? parsedPeriods[^1].Year.ToString()
                    : $"{parsedPeriods[0].Year}/{parsedPeriods[^1].Year}";

                // SC: each CF quarter shifted back by exactly 1 quarter
                // (e.g. H1 Q1+Q2 → SC = Q4 prev year + Q1 curr year)
                var scList = parsedPeriods.Select(p => ShiftQuarter(p.Quarter, p.Year, -1)).ToList();
                string scQLabel = FormatQuarterList(scList.Select(p => p.Quarter).ToList());
                string scYLabel = scList[0].Year == scList[^1].Year
                    ? scList[0].Year.ToString()
                    : $"{scList[0].Year}/{scList[^1].Year}";

                // TO: each CF period shifted back by 4 quarters (one year earlier)
                var toList = parsedPeriods.Select(p => ShiftQuarter(p.Quarter, p.Year, -4)).ToList();
                string toQLabel = FormatQuarterList(toList.Select(p => p.Quarter).ToList());
                string toYLabel = toList[0].Year == toList[^1].Year
                    ? toList[0].Year.ToString()
                    : $"{toList[0].Year}/{toList[^1].Year}";

                // Patch Case Finding sheet (ws 2)
                var wsCf = wb.Worksheets.Worksheet(2);
                wsCf.Cell("N8").SetValue(cfQLabel);
                wsCf.Cell("Q8").SetValue(cfYLabel);

                // Patch Sputum Conversion sheet (ws 3)
                var wsSc = wb.Worksheets.Worksheet(3);
                wsSc.Cell("L8").SetValue(scQLabel);
                wsSc.Cell("P8").SetValue(scYLabel);

                // Patch Treatment Outcome sheet (ws 4)
                var wsTo = wb.Worksheets.Worksheet(4);
                wsTo.Cell("P8").SetValue(toQLabel);
                wsTo.Cell("W8").SetValue(toYLabel);

                // Patch Treatment Outcome summary sheet (ws 5)
                if (wb.Worksheets.Count >= 5)
                {
                    wb.Worksheets.Worksheet(5).Cell("M8").SetValue(cfQLabel);
                    wb.Worksheets.Worksheet(5).Cell("Q8").SetValue(toYLabel);
                }
            }

            using var ms = new MemoryStream();
            wb.SaveAs(ms);
            byte[] excelBytes = ms.ToArray();

            string safeGeo  = string.Concat(geoLabel.Where(c => c != '"' && c != '\\' && c != '/' && c != ':' && c != '*' && c != '?' && c != '<' && c != '>' && c != '|').Take(60)).Trim();
            string safePeriod = string.Concat(periodLabel.Where(c => c != '"' && c != '\\' && c != '/' && c != ':' && c != '*' && c != '?' && c != '<' && c != '>' && c != '|'));
            string filename = $"{safeGeo}_NTP_from_DHIS2_{FormatDhis2PeriodForFilename(safePeriod)}_DHIS.xlsx";

            _logger.LogInformation(
                "tb-read-ntp: user {UserId} fetched periods [{Periods}] for {N} facilities from DHIS2",
                User.FindFirstValue("user_id"), string.Join(",", periods), uids.Count);

            var token = Guid.NewGuid().ToString("N");
            _cache.Set(token, new Dhis2CacheEntry(excelBytes, filename),
                new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5) });
            await Emit(new { done = true, token, filename, step = totalSteps, total = totalSteps });
        }
        catch (OperationCanceledException) { return; }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in tb-read-ntp for periods [{Periods}]", string.Join(",", periods));
            try { await Emit(new { error = "An internal error occurred reading data from DHIS2." }); } catch { }
        }
    }

    // =========================================================================
    //  GET /api/dhis2/tb-read-ntp-download?token=<token>
    // =========================================================================
    /// <summary>
    /// One-time download endpoint: retrieves the Excel file prepared by
    /// tb-read-ntp and cached in IMemoryCache.  Token is consumed on first use.
    /// </summary>
    [HttpGet("tb-read-ntp-download")]
    public IActionResult DownloadReadNtp([FromQuery] string token)
    {
        if (string.IsNullOrEmpty(token) || !Guid.TryParseExact(token, "N", out _))
            return BadRequest(new { error = "Invalid or missing download token." });

        if (!_cache.TryGetValue(token, out Dhis2CacheEntry? entry) || entry is null)
            return NotFound(new { error = "Download token has expired or was not found. Please regenerate the report." });

        _cache.Remove(token);
        return File(entry.Bytes,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            entry.Filename);
    }

    // =========================================================================
    //  POST /api/dhis2/tb-send
    // =========================================================================
    /// <summary>
    /// Submits selected facilities' TB report data to DHIS2 (training or production
    /// instance as configured in appsettings). Logs each submission to DHIS_LogT.
    /// </summary>
    [HttpPost("tb-send")]
    public async Task<IActionResult> Send([FromBody] TbSendRequest req)
    {
        if (req.FacilityUids is null || req.FacilityUids.Count == 0)
            return BadRequest(new { error = "No facilities selected." });

        string userId     = User.FindFirstValue("user_id") ?? "0";
        string userTidStr = User.FindFirstValue(System.IdentityModel.Tokens.Jwt.JwtRegisteredClaimNames.Sub) ?? "";
        int.TryParse(userId,    out var userIdInt);
        Guid.TryParse(userTidStr, out var userTid);

        string cacheKey = BuildCacheKey(userId, req.CfQuarter, req.CfYear,
            req.ScQuarter, req.ScYear, req.ToQuarter, req.ToYear);

        if (!_cache.TryGetValue<Dictionary<string, FacilityCache>>(cacheKey, out var cacheDict)
            || cacheDict is null)
            return BadRequest(new { error = "Session expired. Please re-run Prepare." });

        // DHIS2 connection details
        bool   useTraining = _config.GetValue<bool>("Dhis2:UseTraining", true);
        string section     = useTraining ? "Dhis2:Training" : "Dhis2:Production";
        string dhisUrl     = _config[$"{section}:Url"] ?? string.Empty;
        string dhisUser    = _config[$"{section}:Username"] ?? string.Empty;
        string dhisPwd     = _config[$"{section}:Password"] ?? string.Empty;

        if (string.IsNullOrWhiteSpace(dhisUrl))
            return StatusCode(500, new { error = "DHIS2 URL is not configured." });

        var succeeded = new List<FacilityResultItem>();
        var failed    = new List<FacilityResultItem>();
        string completeDate = DateTime.UtcNow.ToString("yyyy-MM-dd");

        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        var httpClient = _httpFactory.CreateClient("dhis2");
        var authToken  = Convert.ToBase64String(Encoding.ASCII.GetBytes($"{dhisUser}:{dhisPwd}"));
        httpClient.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Basic", authToken);

        foreach (var uid in req.FacilityUids)
        {
            if (!cacheDict.TryGetValue(uid, out var fac)) continue;

            bool   facilitySuccess = true;
            var    errorDetails    = new List<string>();

            foreach (var (dataSet, values, map) in new[]
            {
                (CfDataSet, fac.CfValues, ActiveCfMap),
                (ToDataSet, fac.ToValues, ToMap),
            })
            {
                var payload = BuildDhis2Payload(
                    dataSet, fac.Period, uid, completeDate, values, map);

                string response;
                bool   success;
                try
                {
                    var content = new StringContent(
                        JsonSerializer.Serialize(payload),
                        Encoding.UTF8, "application/json");

                    var httpResp = await httpClient.PostAsync(dhisUrl, content);
                    response = await httpResp.Content.ReadAsStringAsync();
                    // Check HTTP status first, then verify DHIS2 JSON status == "OK"
                    // (avoids false match on "successfully" in description strings)
                    success = false;
                    if (httpResp.IsSuccessStatusCode)
                    {
                        try
                        {
                            using var d = JsonDocument.Parse(response);
                            if (d.RootElement.TryGetProperty("status", out var sp))
                                success = string.Equals(sp.GetString(), "OK", StringComparison.OrdinalIgnoreCase);
                            else
                                success = response.Contains("\"SUCCESS\"", StringComparison.OrdinalIgnoreCase);
                        }
                        catch { success = false; }
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "HTTP error sending {DataSet} for {Uid}", dataSet, uid);
                    response = ex.Message;
                    success  = false;
                }

                if (!success)
                {
                    facilitySuccess = false;
                    // Extract meaningful error detail from the DHIS2 JSON response
                    try
                    {
                        using var doc = JsonDocument.Parse(response);
                        var root = doc.RootElement;
                        int? code = root.TryGetProperty("httpStatusCode", out var cProp) ? cProp.GetInt32() : (int?)null;
                        string? msg  = root.TryGetProperty("message", out var mProp)  ? mProp.GetString()  : null;

                        string detail;
                        // Check for conflicts array in response.conflicts
                        if (root.TryGetProperty("response", out var respEl) &&
                            respEl.TryGetProperty("conflicts", out var conflictsEl) &&
                            conflictsEl.ValueKind == JsonValueKind.Array &&
                            conflictsEl.GetArrayLength() > 0)
                        {
                            int n = conflictsEl.GetArrayLength();
                            var errorCodes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                            string? firstValue = null;
                            foreach (var c in conflictsEl.EnumerateArray())
                            {
                                if (c.TryGetProperty("errorCode", out var ec)) errorCodes.Add(ec.GetString() ?? "?");
                                if (firstValue == null && c.TryGetProperty("value", out var vp))
                                {
                                    var v = vp.GetString() ?? "";
                                    int tick = v.LastIndexOf(": `");
                                    firstValue = tick > 0 ? v[..tick] : v[..Math.Min(80, v.Length)];
                                }
                            }
                            string codes = errorCodes.Count > 0 ? string.Join("/", errorCodes) : "E?";
                            detail = $"Error code: {code} \u2014 {n} conflict{(n > 1 ? "s" : "")} [{codes}: {firstValue ?? "unknown"}]";
                        }
                        else if (!string.IsNullOrWhiteSpace(msg) &&
                                 !string.Equals(msg, "OK", StringComparison.OrdinalIgnoreCase))
                        {
                            detail = $"Error code: {code} \u2014 {msg}";
                        }
                        else
                        {
                            detail = $"Error code: {code} \u2014 Submission rejected by DHIS2";
                        }
                        errorDetails.Add(detail);
                    }
                    catch
                    {
                        errorDetails.Add(string.IsNullOrWhiteSpace(response)
                            ? "Unknown error"
                            : response[..Math.Min(150, response.Length)]);
                    }
                }

                // Log each data value row to DHIS_LogT
                await LogSubmissionAsync(conn, fac, dataSet, values, map,
                    userIdInt, userTid, useTraining, success, response);
            }

            var errorDetail = errorDetails.Count > 0
                ? string.Join(" | ", errorDetails.Distinct())
                : null;

            if (facilitySuccess)
                succeeded.Add(new FacilityResultItem(fac.FacilityName, uid));
            else
                failed.Add(new FacilityResultItem(fac.FacilityName, uid, errorDetail));
        }

        return Ok(new TbSendResultDto(succeeded, failed));
    }

    // =========================================================================
    //  Private helpers
    // =========================================================================

    // ── DHIS2 read helpers ────────────────────────────────────────────────────

    /// <summary>
    /// Fetches a DHIS2 dataValueSets GET response and accumulates all returned
    /// data values into <paramref name="agg"/> keyed by (dataElement, categoryOptionCombo).
    /// Values for the same key are summed (supports multiple org units).
    /// </summary>
    private static async Task FetchAndAggregateAsync(
        HttpClient client,
        string url,
        Dictionary<(string De, string Coc), int> agg)
    {
        HttpResponseMessage resp;
        try
        {
            resp = await client.GetAsync(url);
        }
        catch
        {
            return; // network failure — caller will surface zero values
        }

        if (!resp.IsSuccessStatusCode) return;

        string json = await resp.Content.ReadAsStringAsync();
        if (json.Length < 10) return;

        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("dataValues", out var dvArr)) return;

            foreach (var dv in dvArr.EnumerateArray())
            {
                string de  = dv.TryGetProperty("dataElement",         out var dep)  ? dep.GetString()  ?? "" : "";
                string coc = dv.TryGetProperty("categoryOptionCombo", out var cocp) ? cocp.GetString() ?? "" : "";
                string vs  = dv.TryGetProperty("value",               out var vp)   ? vp.GetString()   ?? "0" : "0";

                if (string.IsNullOrEmpty(de) || string.IsNullOrEmpty(coc)) continue;
                int.TryParse(vs, out var val);

                var key = (de, coc);
                agg.TryGetValue(key, out var existing);
                agg[key] = existing + val;
            }
        }
        catch
        {
            // malformed JSON from DHIS2 — ignore, leave agg unchanged
        }
    }

    // ── Quarter maths ─────────────────────────────────────────────────────────

    /// <summary>
    /// Formats a list of quarter numbers as a readable English list.
    /// e.g. [1, 2] → "1 and 2";  [1, 2, 3, 4] → "1, 2, 3 and 4"
    /// </summary>
    private static string FormatQuarterList(List<int> quarters)
    {
        if (quarters.Count == 0) return "";
        if (quarters.Count == 1) return quarters[0].ToString();
        var strs = quarters.Select(q => q.ToString()).ToList();
        return string.Join(", ", strs[..^1]) + " and " + strs[^1];
    }

    /// <summary>
    /// Converts a DHIS2 period label (e.g. "2026Q1" or "2026Q1-2026Q2") to a
    /// filename-friendly format (e.g. "Q1_2026" or "Q1-Q2_2026").
    /// </summary>
    private static string FormatDhis2PeriodForFilename(string periodLabel)
    {
        var parts = periodLabel.Split('-');
        if (parts.Length >= 2)
        {
            string year     = parts[^1].Contains('Q') ? parts[^1].Split('Q')[0] : "";
            string quarters = string.Join("-", parts.Select(p =>
                p.Contains('Q') ? "Q" + p.Split('Q')[1] : p));
            return string.IsNullOrEmpty(year) ? quarters : $"{quarters}_{year}";
        }
        int qIndex = periodLabel.IndexOf('Q');
        if (qIndex > 0 && qIndex < periodLabel.Length - 1)
            return $"Q{periodLabel[(qIndex + 1)..]}_{periodLabel[..qIndex]}";
        return periodLabel;
    }

    private static (int Quarter, int Year) ShiftQuarter(int quarter, int year, int offset)
    {
        var date = new DateTime(year, (quarter - 1) * 3 + 1, 1)
            .AddMonths(offset * 3);
        return ((date.Month - 1) / 3 + 1, date.Year);
    }

    private static (DateOnly Start, DateOnly End) QuarterDates(int quarter, int year)
    {
        int startMonth = (quarter - 1) * 3 + 1;
        int endMonth   = quarter * 3;
        var start = new DateOnly(year, startMonth, 1);
        var end   = new DateOnly(year, endMonth,
            DateTime.DaysInMonth(year, endMonth));
        return (start, end);
    }

    private static string BuildCacheKey(
        string userId,
        int cfQ, int cfY,
        int? scQ, int? scY,
        int? toQ, int? toY)
    {
        var (defScQ, defScY) = ShiftQuarter(cfQ, cfY, -1);
        var (defToQ, defToY) = ShiftQuarter(cfQ, cfY, -4);
        return $"dhis2_tb_{userId}_{cfQ}_{cfY}" +
               $"_{scQ ?? defScQ}_{scY ?? defScY}" +
               $"_{toQ ?? defToQ}_{toY ?? defToY}";
    }

    // ── Scope / facility list ─────────────────────────────────────────────────

    private sealed record FacilityRow(
        int FacilityId, string FacilityName, string Uid, string County, string State, string StateShort);

    private static async Task<List<FacilityRow>> GetFacilitiesInScopeAsync(
        SqlConnection conn,
        int facilityId, int countyId, int stateId, bool isSuperUser)
    {
        string whereClause = isSuperUser || (facilityId == 0 && countyId == 0 && stateId == 0)
            ? "1=1"
            : stateId > 0
                ? "hf.StateID = @StateId"
                : countyId > 0
                    ? "hf.CountyID = @CountyId"
                    : "hf.HealthFacilityID = @FacilityId";

        string sql = $"""
            SELECT hf.HealthFacilityID, hf.HealthFacility, hf.UID,
                   c.County, s.State, COALESCE(s.StateShort, s.State, '')
            FROM   HealthFacilityT hf
            INNER JOIN CountyT c ON c.CountyID = hf.CountyID
            INNER JOIN StateT  s ON s.StateID  = hf.StateID
            WHERE  hf.UID IS NOT NULL AND LTRIM(RTRIM(hf.UID)) <> ''
              AND  {whereClause}
            ORDER BY s.State, c.County, hf.HealthFacility
            """;

        await using var cmd = new SqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("@StateId",    stateId);
        cmd.Parameters.AddWithValue("@CountyId",   countyId);
        cmd.Parameters.AddWithValue("@FacilityId", facilityId);

        var list = new List<FacilityRow>();
        await using var rs = await cmd.ExecuteReaderAsync();
        while (await rs.ReadAsync())
        {
            list.Add(new FacilityRow(
                rs.GetInt32(0),
                rs.GetString(1),
                rs.GetString(2),
                rs.GetString(3),
                rs.GetString(4),
                rs.IsDBNull(5) ? rs.GetString(4) : rs.GetString(5)));
        }
        return list;
    }

    // ── Report computation ────────────────────────────────────────────────────

    private static async Task<(int[] CfVals, int[] ToVals)> ComputeFacilityAsync(
        SqlConnection conn,
        int facilityId,
        DateOnly cfStart, DateOnly cfEnd,
        DateOnly scStart, DateOnly scEnd,
        DateOnly toStart, DateOnly toEnd)
    {
        // All counter variables — matching the original ASP.NET code exactly
        int cf_PBCNew = 0, cf_PBCRelapse = 0, cf_PBCPrevTreat = 0, cf_PBCOther = 0;
        int cf_PCDNew = 0, cf_PCDRelapse = 0, cf_PCDPrevTreat = 0, cf_PCDOther = 0;
        int cf_EPNew  = 0, cf_EPRelapse  = 0, cf_EPPrevTreat  = 0, cf_EPOther  = 0;
        int cf_PBCNewU5M = 0, cf_PBCNew5_9M = 0, cf_PBCNew10_14M = 0, cf_PBCNew15_19M = 0, cf_PBCNew20_24M = 0;
        int cf_PBCNew25_34M = 0, cf_PBCNew35_44M = 0, cf_PBCNew45_54M = 0, cf_PBCNew55_64M = 0, cf_PBCNew65PlusM = 0;
        int cf_PBCNewU5F = 0, cf_PBCNew5_9F = 0, cf_PBCNew10_14F = 0, cf_PBCNew15_19F = 0, cf_PBCNew20_24F = 0;
        int cf_PBCNew25_34F = 0, cf_PBCNew35_44F = 0, cf_PBCNew45_54F = 0, cf_PBCNew55_64F = 0, cf_PBCNew65PlusF = 0;
        int cf_SuspectsSeen = 0, cf_PBCLab = 0;
        int cf_TestedHIV = 0, cf_TestedHIVPos = 0, cf_TestedHIVART = 0, cf_TestedHIVCPT = 0;
        int cf_GeneXpert = 0, cf_Microscopy = 0, cf_TBLam = 0, cf_TrueNat = 0, cf_Xray = 0;
        int cf_GeneXpert_Pos = 0, cf_Microscopy_Pos = 0, cf_TBLam_Pos = 0, cf_TrueNat_Pos = 0, cf_Xray_Pos = 0;
        int cf_TestedHIVPosU5M = 0, cf_TestedHIVPos5_9M = 0, cf_TestedHIVPos10_14M = 0;
        int cf_TestedHIVPos15_19M = 0, cf_TestedHIVPos20_24M = 0, cf_TestedHIVPos25_34M = 0;
        int cf_TestedHIVPos35_44M = 0, cf_TestedHIVPos45_54M = 0, cf_TestedHIVPos55_64M = 0, cf_TestedHIVPos65PlusM = 0;
        int cf_TestedHIVPosU5F = 0, cf_TestedHIVPos5_9F = 0, cf_TestedHIVPos10_14F = 0;
        int cf_TestedHIVPos15_19F = 0, cf_TestedHIVPos20_24F = 0, cf_TestedHIVPos25_34F = 0;
        int cf_TestedHIVPos35_44F = 0, cf_TestedHIVPos45_54F = 0, cf_TestedHIVPos55_64F = 0, cf_TestedHIVPos65PlusF = 0;
        int cf_ARTHIVPos0_4M = 0, cf_ARTHIVPos5_9M = 0, cf_ARTHIVPos10_14M = 0, cf_ARTHIVPos15_19M = 0, cf_ARTHIVPos20_24M = 0;
        int cf_ARTHIVPos25_34M = 0, cf_ARTHIVPos35_44M = 0, cf_ARTHIVPos45_54M = 0, cf_ARTHIVPos55_64M = 0, cf_ARTHIVPos65PlusM = 0;
        int cf_ARTHIVPos0_4F = 0, cf_ARTHIVPos5_9F = 0, cf_ARTHIVPos10_14F = 0, cf_ARTHIVPos15_19F = 0, cf_ARTHIVPos20_24F = 0;
        int cf_ARTHIVPos25_34F = 0, cf_ARTHIVPos35_44F = 0, cf_ARTHIVPos45_54F = 0, cf_ARTHIVPos55_64F = 0, cf_ARTHIVPos65PlusF = 0;

        int sc_NewPBC = 0, sc_SmearND = 0, sc_2Months = 0, sc_3Months = 0;

        int to_NewPBCM = 0, to_NewPBCF = 0;
        int to_NewPBC_CuredM = 0, to_NewPBC_CuredF = 0, to_NewPBC_CompletedM = 0, to_NewPBC_CompletedF = 0;
        int to_NewPBC_DiedM = 0, to_NewPBC_DiedF = 0, to_NewPBC_FailedM = 0, to_NewPBC_FailedF = 0;
        int to_NewPBC_LostToFPM = 0, to_NewPBC_LostToFPF = 0, to_NewPBC_NotEvalM = 0, to_NewPBC_NotEvalF = 0;
        int to_NewPCDEPM = 0, to_NewPCDEPF = 0;
        int to_NewPCDEP_CompletedM = 0, to_NewPCDEP_CompletedF = 0;
        int to_NewPCDEP_DiedM = 0, to_NewPCDEP_DiedF = 0, to_NewPCDEP_FailedM = 0, to_NewPCDEP_FailedF = 0;
        int to_NewPCDEP_LostToFPM = 0, to_NewPCDEP_LostToFPF = 0, to_NewPCDEP_NotEvalM = 0, to_NewPCDEP_NotEvalF = 0;
        int to_RelapseM = 0, to_RelapseF = 0;
        int to_Relapse_CuredM = 0, to_Relapse_CuredF = 0, to_Relapse_CompletedM = 0, to_Relapse_CompletedF = 0;
        int to_Relapse_DiedM = 0, to_Relapse_DiedF = 0, to_Relapse_FailedM = 0, to_Relapse_FailedF = 0;
        int to_Relapse_LostToFPM = 0, to_Relapse_LostToFPF = 0, to_Relapse_NotEvalM = 0, to_Relapse_NotEvalF = 0;
        int to_Failure = 0, to_Failure_Cured = 0, to_Failure_Completed = 0, to_Failure_Died = 0;
        int to_Failure_Failed = 0, to_Failure_LostToFP = 0, to_Failure_NotEval = 0;
        int to_LostToFP = 0, to_LostToFP_Cured = 0, to_LostToFP_Completed = 0, to_LostToFP_Died = 0;
        int to_LostToFP_Failed = 0, to_LostToFP_LostToFP = 0, to_LostToFP_NotEval = 0;
        int to_Other = 0, to_Other_Cured = 0, to_Other_Completed = 0, to_Other_Died = 0;
        int to_Other_Failed = 0, to_Other_LostToFP = 0, to_Other_NotEval = 0;
        int to_TestedHIV = 0, to_TestedHIVPos = 0, to_TestedHIVART = 0, to_TestedHIVCPT = 0;
        int to_HIVPos_Cured = 0, to_HIVPos_Completed = 0, to_HIVPos_Died = 0;
        int to_HIVPos_Failed = 0, to_HIVPos_LostToFP = 0, to_HIVPos_NotEval = 0;
        int to_Chn = 0, to_Chn_Cured = 0, to_Chn_Completed = 0, to_Chn_Died = 0;
        int to_Chn_Failed = 0, to_Chn_LostToFP = 0, to_Chn_NotEval = 0;
        int to_Adol = 0, to_Adol_Cured = 0, to_Adol_Completed = 0, to_Adol_Died = 0;
        int to_Adol_Failed = 0, to_Adol_LostToFP = 0, to_Adol_NotEval = 0;

        // ── CASE FINDING query ───────────────────────────────────────────────
        const string patientSql = """
            SELECT
                p.PtTypeID,
                p.TbTypeID,
                p.SexID,
                COALESCE(p.Age, 0)                AS Age,
                COALESCE(p.DiagMethodID, 0)        AS DiagMethodID,
                COALESCE(f.Mon0LabResultID,  0)    AS Mon0LabResultID,
                COALESCE(f.Mon0XpertResultID,0)    AS Mon0XpertResultID,
                COALESCE(f.HIVTestResultID,  0)    AS HIVTestResultID,
                COALESCE(f.OnART, 0)               AS OnART,
                COALESCE(f.OnCPT, 0)               AS OnCPT,
                COALESCE(f.Mon2LabResultID,  0)    AS Mon2LabResultID,
                COALESCE(f.Mon3LabResultID,  0)    AS Mon3LabResultID,
                COALESCE(f.OutcomeID,        0)    AS OutcomeID
            FROM   PtDetailsT  p
            LEFT JOIN PtFollowUpT f
                   ON f.PtDetailsTID = p.PtDetailsTID AND f.Deleted = 0
            WHERE  p.Deleted       = 0
              AND  p.PtTypeID      IN (1,2,3,4,6)
              AND  p.NearestHFID   = @FacilityId
              AND  p.RegDate       BETWEEN @Start AND @End
            """;

        await using (var cmd = new SqlCommand(patientSql, conn))
        {
            cmd.Parameters.AddWithValue("@FacilityId", facilityId);
            cmd.Parameters.AddWithValue("@Start",      cfStart.ToDateTime(TimeOnly.MinValue));
            cmd.Parameters.AddWithValue("@End",        cfEnd.ToDateTime(TimeOnly.MinValue));

            await using var rs = await cmd.ExecuteReaderAsync();
            while (await rs.ReadAsync())
            {
                int ptType    = rs.GetInt32(0);
                int tbType    = rs.GetInt32(1);
                int sex       = rs.GetInt32(2);
                int age       = rs.GetInt32(3);
                int diagMeth  = rs.GetInt32(4);
                int mon0Lab   = rs.GetInt32(5);
                int mon0Xpert = rs.GetInt32(6);
                int hivResult = rs.GetInt32(7);
                int onArt     = rs.GetInt32(8);
                int onCpt     = rs.GetInt32(9);

                // PBC positive: sputum 1,4,5,6 (Scanty,1+,2+,3+) OR Xpert 3,4,5 (T,TI,RR)
                bool isPBC = tbType == 1 &&
                    (mon0Lab is 1 or 4 or 5 or 6 || mon0Xpert is 3 or 4 or 5);

                // PCD = P but NOT bacteriologically confirmed
                bool isPCD = (mon0Xpert is not (3 or 4 or 5)) &&
                    (tbType == 2 ||  // historical PCD type (may be 0 in new system)
                     (tbType == 1 && mon0Lab is 2 or 3 or 7));

                bool isEP   = tbType == 3;
                bool isNewR = ptType is 1 or 2; // New or Relapse (for age/sex breakdown)

                // Case type counts
                if (isPBC)
                {
                    if (ptType == 1) cf_PBCNew++;
                    else if (ptType == 2) cf_PBCRelapse++;
                    else if (ptType is 3 or 4) cf_PBCPrevTreat++;
                    else if (ptType == 6) cf_PBCOther++;
                }
                if (isPCD)
                {
                    if (ptType == 1) cf_PCDNew++;
                    else if (ptType == 2) cf_PCDRelapse++;
                    else if (ptType is 3 or 4) cf_PCDPrevTreat++;
                    else if (ptType == 6) cf_PCDOther++;
                }
                if (isEP)
                {
                    if (ptType == 1) cf_EPNew++;
                    else if (ptType == 2) cf_EPRelapse++;
                    else if (ptType is 3 or 4) cf_EPPrevTreat++;
                    else if (ptType == 6) cf_EPOther++;
                }

                // Age/sex breakdown for new+relapse (male)
                if (isNewR && sex == 1)
                {
                    if (age < 5)                    cf_PBCNewU5M++;
                    else if (age is >= 5  and < 10) cf_PBCNew5_9M++;
                    else if (age is >= 10 and < 15) cf_PBCNew10_14M++;
                    else if (age is >= 15 and < 20) cf_PBCNew15_19M++;
                    else if (age is >= 20 and < 25) cf_PBCNew20_24M++;
                    else if (age is >= 25 and < 35) cf_PBCNew25_34M++;
                    else if (age is >= 35 and < 45) cf_PBCNew35_44M++;
                    else if (age is >= 45 and < 55) cf_PBCNew45_54M++;
                    else if (age is >= 55 and < 65) cf_PBCNew55_64M++;
                    else                            cf_PBCNew65PlusM++;
                }

                // Age/sex breakdown for new+relapse (female)
                if (isNewR && sex == 2)
                {
                    if (age < 5)                    cf_PBCNewU5F++;
                    else if (age is >= 5  and < 10) cf_PBCNew5_9F++;
                    else if (age is >= 10 and < 15) cf_PBCNew10_14F++;
                    else if (age is >= 15 and < 20) cf_PBCNew15_19F++;
                    else if (age is >= 20 and < 25) cf_PBCNew20_24F++;
                    else if (age is >= 25 and < 35) cf_PBCNew25_34F++;
                    else if (age is >= 35 and < 45) cf_PBCNew35_44F++;
                    else if (age is >= 45 and < 55) cf_PBCNew45_54F++;
                    else if (age is >= 55 and < 65) cf_PBCNew55_64F++;
                    else                            cf_PBCNew65PlusF++;
                }

                // PBC diagnosed by lab
                if (ptType is not (5 or 7) && isPBC) cf_PBCLab++;

                // HIV activities (new+relapse only)
                if (isNewR)
                {
                    if (hivResult is 1 or 2) cf_TestedHIV++;
                    if (hivResult == 2)
                    {
                        cf_TestedHIVPos++;
                        if (onArt == 1) cf_TestedHIVART++;
                        if (onCpt == 1) cf_TestedHIVCPT++;
                    }
                }

                // Diagnostic method (new+relapse)
                if (isNewR)
                {
                    switch (diagMeth)
                    {
                        case 1: cf_GeneXpert++;    break;
                        case 2: cf_Microscopy++;   break;
                        case 3: cf_TBLam++;        break;
                        case 4: cf_TrueNat++;      break;
                        default: cf_Xray++;        break; // 0=NR or 5=Others/Xray
                    }
                    if (mon0Xpert is 3 or 4 or 5 && diagMeth == 1) cf_GeneXpert_Pos++;
                    if (mon0Lab is 1 or 4 or 5 or 6 && diagMeth == 2) cf_Microscopy_Pos++;
                    if (mon0Xpert is 3 or 4 or 5 && diagMeth == 3) cf_TBLam_Pos++;
                    if (mon0Xpert is 3 or 4 or 5 && diagMeth == 4) cf_TrueNat_Pos++;
                }

                // HIV+ by age/sex (new+relapse)
                if (isNewR && hivResult == 2)
                {
                    if (sex == 1)
                    {
                        if (age < 5)                    cf_TestedHIVPosU5M++;
                        else if (age is >= 5  and < 10) cf_TestedHIVPos5_9M++;
                        else if (age is >= 10 and < 15) cf_TestedHIVPos10_14M++;
                        else if (age is >= 15 and < 20) cf_TestedHIVPos15_19M++;
                        else if (age is >= 20 and < 25) cf_TestedHIVPos20_24M++;
                        else if (age is >= 25 and < 35) cf_TestedHIVPos25_34M++;
                        else if (age is >= 35 and < 45) cf_TestedHIVPos35_44M++;
                        else if (age is >= 45 and < 55) cf_TestedHIVPos45_54M++;
                        else if (age is >= 55 and < 65) cf_TestedHIVPos55_64M++;
                        else                            cf_TestedHIVPos65PlusM++;
                    }
                    else if (sex == 2)
                    {
                        if (age < 5)                    cf_TestedHIVPosU5F++;
                        else if (age is >= 5  and < 10) cf_TestedHIVPos5_9F++;
                        else if (age is >= 10 and < 15) cf_TestedHIVPos10_14F++;
                        else if (age is >= 15 and < 20) cf_TestedHIVPos15_19F++;
                        else if (age is >= 20 and < 25) cf_TestedHIVPos20_24F++;
                        else if (age is >= 25 and < 35) cf_TestedHIVPos25_34F++;
                        else if (age is >= 35 and < 45) cf_TestedHIVPos35_44F++;
                        else if (age is >= 45 and < 55) cf_TestedHIVPos45_54F++;
                        else if (age is >= 55 and < 65) cf_TestedHIVPos55_64F++;
                        else                            cf_TestedHIVPos65PlusF++;
                    }

                    // HIV+ on ART by age/sex
                    if (onArt == 1)
                    {
                        if (sex == 1)
                        {
                            if (age < 5)                    cf_ARTHIVPos0_4M++;
                            else if (age is >= 5  and < 10) cf_ARTHIVPos5_9M++;
                            else if (age is >= 10 and < 15) cf_ARTHIVPos10_14M++;
                            else if (age is >= 15 and < 20) cf_ARTHIVPos15_19M++;
                            else if (age is >= 20 and < 25) cf_ARTHIVPos20_24M++;
                            else if (age is >= 25 and < 35) cf_ARTHIVPos25_34M++;
                            else if (age is >= 35 and < 45) cf_ARTHIVPos35_44M++;
                            else if (age is >= 45 and < 55) cf_ARTHIVPos45_54M++;
                            else if (age is >= 55 and < 65) cf_ARTHIVPos55_64M++;
                            else                            cf_ARTHIVPos65PlusM++;
                        }
                        else if (sex == 2)
                        {
                            if (age < 5)                    cf_ARTHIVPos0_4F++;
                            else if (age is >= 5  and < 10) cf_ARTHIVPos5_9F++;
                            else if (age is >= 10 and < 15) cf_ARTHIVPos10_14F++;
                            else if (age is >= 15 and < 20) cf_ARTHIVPos15_19F++;
                            else if (age is >= 20 and < 25) cf_ARTHIVPos20_24F++;
                            else if (age is >= 25 and < 35) cf_ARTHIVPos25_34F++;
                            else if (age is >= 35 and < 45) cf_ARTHIVPos35_44F++;
                            else if (age is >= 45 and < 55) cf_ARTHIVPos45_54F++;
                            else if (age is >= 55 and < 65) cf_ARTHIVPos55_64F++;
                            else                            cf_ARTHIVPos65PlusF++;
                        }
                    }
                }
            }
        }

        // ── SPUTUM CONVERSION query ──────────────────────────────────────────
        await using (var cmd = new SqlCommand(patientSql, conn))
        {
            cmd.Parameters.AddWithValue("@FacilityId", facilityId);
            cmd.Parameters.AddWithValue("@Start",      scStart.ToDateTime(TimeOnly.MinValue));
            cmd.Parameters.AddWithValue("@End",        scEnd.ToDateTime(TimeOnly.MinValue));

            await using var rs = await cmd.ExecuteReaderAsync();
            while (await rs.ReadAsync())
            {
                int ptType    = rs.GetInt32(0);
                int tbType    = rs.GetInt32(1);
                int mon0Lab   = rs.GetInt32(5);
                int mon0Xpert = rs.GetInt32(6);
                int mon2Lab   = rs.GetInt32(10);
                int mon3Lab   = rs.GetInt32(11);

                bool isNewPBC = ptType == 1 && tbType == 1 &&
                    (mon0Lab is 1 or 4 or 5 or 6 || mon0Xpert is 3 or 4 or 5);

                if (isNewPBC)
                {
                    sc_NewPBC++;
                    if (mon2Lab is 3 or 7 && mon3Lab is 3 or 7 or 0) sc_SmearND++;
                    if (mon2Lab == 2) sc_2Months++;
                    if (mon3Lab == 2 && mon2Lab != 2) sc_3Months++;
                }
            }
        }

        // ── PRESUMPTIVE CASES query ──────────────────────────────────────────
        // Sums monthly tally counts for the CF quarter months/year
        const string presumptiveSql = """
            SELECT COALESCE(SUM(pc.PresumptiveCase), 0)
            FROM   PresumptiveCaseT pc
            INNER JOIN MonthT m ON m.MonthID = pc.MonthID
            INNER JOIN YearT  y ON y.YearID  = pc.YearID
            WHERE  pc.NearestHFID = @FacilityId
              AND  y.YearName     = @Year
              AND  m.MonthID      IN (@M1, @M2, @M3)
            """;

        await using (var cmd = new SqlCommand(presumptiveSql, conn))
        {
            int startMonth = (cfStart.Month);
            cmd.Parameters.AddWithValue("@FacilityId", facilityId);
            cmd.Parameters.AddWithValue("@Year",       cfStart.Year);
            cmd.Parameters.AddWithValue("@M1",         startMonth);
            cmd.Parameters.AddWithValue("@M2",         startMonth + 1);
            cmd.Parameters.AddWithValue("@M3",         startMonth + 2);
            var scalar = await cmd.ExecuteScalarAsync();
            cf_SuspectsSeen = scalar is DBNull ? 0 : Convert.ToInt32(scalar);
        }

        // ── TREATMENT OUTCOME query ──────────────────────────────────────────
        await using (var cmd = new SqlCommand(patientSql, conn))
        {
            cmd.Parameters.AddWithValue("@FacilityId", facilityId);
            cmd.Parameters.AddWithValue("@Start",      toStart.ToDateTime(TimeOnly.MinValue));
            cmd.Parameters.AddWithValue("@End",        toEnd.ToDateTime(TimeOnly.MinValue));

            await using var rs = await cmd.ExecuteReaderAsync();
            while (await rs.ReadAsync())
            {
                int ptType    = rs.GetInt32(0);
                int tbType    = rs.GetInt32(1);
                int sex       = rs.GetInt32(2);
                int age       = rs.GetInt32(3);
                int mon0Lab   = rs.GetInt32(5);
                int mon0Xpert = rs.GetInt32(6);
                int hivResult = rs.GetInt32(7);
                int onArt     = rs.GetInt32(8);
                int onCpt     = rs.GetInt32(9);
                int outcome   = rs.GetInt32(12);

                bool isPBC = tbType == 1 &&
                    (mon0Lab is 1 or 4 or 5 or 6 || mon0Xpert is 3 or 4 or 5);
                bool isPCDEP = (mon0Xpert is not (3 or 4 or 5)) &&
                    (tbType == 2 || (tbType == 1 && mon0Lab is 2 or 3 or 7));
                bool notPsTI = ptType is not (5 or 7);

                // New PBC outcomes by sex
                if (ptType == 1 && isPBC)
                {
                    if (sex == 1) { to_NewPBCM++; }
                    else          { to_NewPBCF++; }
                    IncrOutcome(outcome, sex,
                        ref to_NewPBC_CuredM,    ref to_NewPBC_CuredF,
                        ref to_NewPBC_CompletedM, ref to_NewPBC_CompletedF,
                        ref to_NewPBC_DiedM,     ref to_NewPBC_DiedF,
                        ref to_NewPBC_FailedM,   ref to_NewPBC_FailedF,
                        ref to_NewPBC_LostToFPM, ref to_NewPBC_LostToFPF,
                        ref to_NewPBC_NotEvalM,  ref to_NewPBC_NotEvalF);
                }

                // New PCD/EP outcomes by sex
                if (ptType == 1 && isPCDEP)
                {
                    if (sex == 1) { to_NewPCDEPM++; }
                    else          { to_NewPCDEPF++; }
                    IncrOutcomeNoCure(outcome, sex,
                        ref to_NewPCDEP_CompletedM, ref to_NewPCDEP_CompletedF,
                        ref to_NewPCDEP_DiedM,      ref to_NewPCDEP_DiedF,
                        ref to_NewPCDEP_FailedM,    ref to_NewPCDEP_FailedF,
                        ref to_NewPCDEP_LostToFPM,  ref to_NewPCDEP_LostToFPF,
                        ref to_NewPCDEP_NotEvalM,   ref to_NewPCDEP_NotEvalF);
                }

                // Relapse outcomes
                if (ptType == 2)
                {
                    if (sex == 1) { to_RelapseM++; }
                    else          { to_RelapseF++; }
                    IncrOutcome(outcome, sex,
                        ref to_Relapse_CuredM,    ref to_Relapse_CuredF,
                        ref to_Relapse_CompletedM, ref to_Relapse_CompletedF,
                        ref to_Relapse_DiedM,     ref to_Relapse_DiedF,
                        ref to_Relapse_FailedM,   ref to_Relapse_FailedF,
                        ref to_Relapse_LostToFPM, ref to_Relapse_LostToFPF,
                        ref to_Relapse_NotEvalM,  ref to_Relapse_NotEvalF);
                }

                // After Failure outcomes
                if (ptType == 3)
                {
                    to_Failure++;
                    switch (outcome)
                    {
                        case 1: to_Failure_Cured++;     break;
                        case 2: to_Failure_Completed++; break;
                        case 3: to_Failure_Died++;      break;
                        case 4: to_Failure_Failed++;    break;
                        case 5: to_Failure_LostToFP++;  break;
                        case 0: case 6: to_Failure_NotEval++; break;
                    }
                }

                // Treatment Interrupted outcomes
                if (ptType == 4)
                {
                    to_LostToFP++;
                    switch (outcome)
                    {
                        case 1: to_LostToFP_Cured++;     break;
                        case 2: to_LostToFP_Completed++; break;
                        case 3: to_LostToFP_Died++;      break;
                        case 4: to_LostToFP_Failed++;    break;
                        case 5: to_LostToFP_LostToFP++;  break;
                        case 0: case 6: to_LostToFP_NotEval++; break;
                    }
                }

                // Other outcomes
                if (ptType == 6)
                {
                    to_Other++;
                    switch (outcome)
                    {
                        case 1: to_Other_Cured++;     break;
                        case 2: to_Other_Completed++; break;
                        case 3: to_Other_Died++;      break;
                        case 4: to_Other_Failed++;    break;
                        case 5: to_Other_LostToFP++;  break;
                        case 0: case 6: to_Other_NotEval++; break;
                    }
                }

                // HIV/TB activities (outcome period)
                if (notPsTI && hivResult is 1 or 2) to_TestedHIV++;
                if (notPsTI && hivResult == 2)
                {
                    to_TestedHIVPos++;
                    if (onArt == 1) to_TestedHIVART++;
                    if (onCpt == 1) to_TestedHIVCPT++;
                    switch (outcome)
                    {
                        case 1: to_HIVPos_Cured++;     break;
                        case 2: to_HIVPos_Completed++; break;
                        case 3: to_HIVPos_Died++;      break;
                        case 4: to_HIVPos_Failed++;    break;
                        case 5: to_HIVPos_LostToFP++;  break;
                        case 0: case 6: to_HIVPos_NotEval++; break;
                    }
                }

                // Children <15
                if (notPsTI && age < 15)
                {
                    to_Chn++;
                    switch (outcome)
                    {
                        case 1: to_Chn_Cured++;     break;
                        case 2: to_Chn_Completed++; break;
                        case 3: to_Chn_Died++;      break;
                        case 4: to_Chn_Failed++;    break;
                        case 5: to_Chn_LostToFP++;  break;
                        default: if (outcome == 0 || outcome >= 6) to_Chn_NotEval++; break;
                    }
                }

                // Adolescents 10–19
                if (notPsTI && age is >= 10 and < 20)
                {
                    to_Adol++;
                    switch (outcome)
                    {
                        case 1: to_Adol_Cured++;     break;
                        case 2: to_Adol_Completed++; break;
                        case 3: to_Adol_Died++;      break;
                        case 4: to_Adol_Failed++;    break;
                        case 5: to_Adol_LostToFP++;  break;
                        default: if (outcome == 0 || outcome >= 6) to_Adol_NotEval++; break;
                    }
                }
            }
        }

        // ── Pack values arrays (order must match CfMap / ToMap) ───────────────
        int[] cfVals =
        {
            cf_PBCNew, cf_PBCRelapse, cf_PBCPrevTreat, cf_PBCOther,
            cf_PCDNew, cf_PCDRelapse, cf_PCDPrevTreat, cf_PCDOther,
            cf_EPNew,  cf_EPRelapse,  cf_EPPrevTreat,  cf_EPOther,
            cf_PBCNewU5M, cf_PBCNew5_9M, cf_PBCNew10_14M, cf_PBCNew15_19M, cf_PBCNew20_24M,
            cf_PBCNew25_34M, cf_PBCNew35_44M, cf_PBCNew45_54M, cf_PBCNew55_64M, cf_PBCNew65PlusM,
            cf_PBCNewU5F, cf_PBCNew5_9F, cf_PBCNew10_14F, cf_PBCNew15_19F, cf_PBCNew20_24F,
            cf_PBCNew25_34F, cf_PBCNew35_44F, cf_PBCNew45_54F, cf_PBCNew55_64F, cf_PBCNew65PlusF,
            cf_SuspectsSeen, cf_PBCLab,
            cf_TestedHIV, cf_TestedHIVPos, cf_TestedHIVART, cf_TestedHIVCPT,
            cf_GeneXpert, cf_Microscopy, cf_TBLam, cf_TrueNat, cf_Xray,
            cf_GeneXpert_Pos, cf_Microscopy_Pos, cf_TBLam_Pos, cf_TrueNat_Pos, cf_Xray_Pos,
            cf_TestedHIVPosU5M, cf_TestedHIVPos5_9M, cf_TestedHIVPos10_14M,
            cf_TestedHIVPos15_19M, cf_TestedHIVPos20_24M, cf_TestedHIVPos25_34M,
            cf_TestedHIVPos35_44M, cf_TestedHIVPos45_54M, cf_TestedHIVPos55_64M, cf_TestedHIVPos65PlusM,
            cf_TestedHIVPosU5F, cf_TestedHIVPos5_9F, cf_TestedHIVPos10_14F,
            cf_TestedHIVPos15_19F, cf_TestedHIVPos20_24F, cf_TestedHIVPos25_34F,
            cf_TestedHIVPos35_44F, cf_TestedHIVPos45_54F, cf_TestedHIVPos55_64F, cf_TestedHIVPos65PlusF,
            cf_ARTHIVPos0_4M, cf_ARTHIVPos5_9M, cf_ARTHIVPos10_14M, cf_ARTHIVPos15_19M, cf_ARTHIVPos20_24M,
            cf_ARTHIVPos25_34M, cf_ARTHIVPos35_44M, cf_ARTHIVPos45_54M, cf_ARTHIVPos55_64M, cf_ARTHIVPos65PlusM,
            cf_ARTHIVPos0_4F, cf_ARTHIVPos5_9F, cf_ARTHIVPos10_14F, cf_ARTHIVPos15_19F, cf_ARTHIVPos20_24F,
            cf_ARTHIVPos25_34F, cf_ARTHIVPos35_44F, cf_ARTHIVPos45_54F, cf_ARTHIVPos55_64F, cf_ARTHIVPos65PlusF,
            sc_NewPBC, sc_SmearND, sc_2Months, sc_3Months,
        };

        int[] toVals =
        {
            to_NewPBCM, to_NewPBCF,
            to_NewPBC_CuredM, to_NewPBC_CuredF,
            to_NewPBC_CompletedM, to_NewPBC_CompletedF,
            to_NewPBC_DiedM, to_NewPBC_DiedF,
            to_NewPBC_FailedM, to_NewPBC_FailedF,
            to_NewPBC_LostToFPM, to_NewPBC_LostToFPF,
            to_NewPBC_NotEvalM, to_NewPBC_NotEvalF,
            to_NewPCDEPM, to_NewPCDEPF,
            to_NewPCDEP_CompletedM, to_NewPCDEP_CompletedF,
            to_NewPCDEP_DiedM, to_NewPCDEP_DiedF,
            to_NewPCDEP_FailedM, to_NewPCDEP_FailedF,
            to_NewPCDEP_LostToFPM, to_NewPCDEP_LostToFPF,
            to_NewPCDEP_NotEvalM, to_NewPCDEP_NotEvalF,
            to_RelapseM, to_RelapseF,
            to_Relapse_CuredM, to_Relapse_CuredF,
            to_Relapse_CompletedM, to_Relapse_CompletedF,
            to_Relapse_DiedM, to_Relapse_DiedF,
            to_Relapse_FailedM, to_Relapse_FailedF,
            to_Relapse_LostToFPM, to_Relapse_LostToFPF,
            to_Relapse_NotEvalM, to_Relapse_NotEvalF,
            to_Failure, to_Failure_Cured, to_Failure_Completed, to_Failure_Died,
            to_Failure_Failed, to_Failure_LostToFP, to_Failure_NotEval,
            to_LostToFP, to_LostToFP_Cured, to_LostToFP_Completed, to_LostToFP_Died,
            to_LostToFP_Failed, to_LostToFP_LostToFP, to_LostToFP_NotEval,
            to_Other, to_Other_Cured, to_Other_Completed, to_Other_Died,
            to_Other_Failed, to_Other_LostToFP, to_Other_NotEval,
            to_TestedHIV, to_TestedHIVPos, to_TestedHIVART, to_TestedHIVCPT,
            to_TestedHIVPos, // orgUnit for HIVPos in OBxOcDrbThw ('Lhru44pCaDo')
            to_HIVPos_Cured, to_HIVPos_Completed, to_HIVPos_Died,
            to_HIVPos_Failed, to_HIVPos_LostToFP, to_HIVPos_NotEval,
            to_Chn, to_Chn_Cured, to_Chn_Completed, to_Chn_Died,
            to_Chn_Failed, to_Chn_LostToFP, to_Chn_NotEval,
            to_Adol, to_Adol_Cured, to_Adol_Completed, to_Adol_Died,
            to_Adol_Failed, to_Adol_LostToFP, to_Adol_NotEval,
        };

        return (cfVals, toVals);
    }

    // ── Outcome accumulator helpers ───────────────────────────────────────────

    private static void IncrOutcome(
        int outcome, int sex,
        ref int curedM,    ref int curedF,
        ref int completedM, ref int completedF,
        ref int diedM,     ref int diedF,
        ref int failedM,   ref int failedF,
        ref int lostM,     ref int lostF,
        ref int notEvalM,  ref int notEvalF)
    {
        switch (outcome)
        {
            case 1: if (sex == 1) curedM++;     else curedF++;     break;
            case 2: if (sex == 1) completedM++; else completedF++; break;
            case 3: if (sex == 1) diedM++;      else diedF++;      break;
            case 4: if (sex == 1) failedM++;    else failedF++;    break;
            case 5: if (sex == 1) lostM++;      else lostF++;      break;
            case 0: case 6: if (sex == 1) notEvalM++; else notEvalF++; break;
        }
    }

    private static void IncrOutcomeNoCure(
        int outcome, int sex,
        ref int completedM, ref int completedF,
        ref int diedM,      ref int diedF,
        ref int failedM,    ref int failedF,
        ref int lostM,      ref int lostF,
        ref int notEvalM,   ref int notEvalF)
    {
        switch (outcome)
        {
            case 2: if (sex == 1) completedM++; else completedF++; break;
            case 3: if (sex == 1) diedM++;      else diedF++;      break;
            case 4: if (sex == 1) failedM++;    else failedF++;    break;
            case 5: if (sex == 1) lostM++;      else lostF++;      break;
            case 0: case 6: if (sex == 1) notEvalM++; else notEvalF++; break;
        }
    }

    // ── DHIS2 payload builder ─────────────────────────────────────────────────

    private static object BuildDhis2Payload(
        string dataSet, string period, string orgUnit, string completeDate,
        int[] values, (string De, string Coc)[] map)
    {
        var dataValues = new List<object>();
        for (int i = 0; i < map.Length && i < values.Length; i++)
        {
            dataValues.Add(new
            {
                dataElement         = map[i].De,
                categoryOptionCombo = map[i].Coc,
                value               = values[i]
            });
        }
        return new
        {
            dataSet,
            completeDate,
            period,
            orgUnit,
            attributeOptionCombo = DefaultAoc,
            dataValues
        };
    }

    // ── DB logging ────────────────────────────────────────────────────────────

    // SubmittedUsingID = 2 identifies rows written by this new eTBr API
    // (the legacy WebForms system used 1, matching [db_ac602a_etbrss].[DHIS_LogT]).
    private static async Task LogSubmissionAsync(
        SqlConnection conn,
        FacilityCache fac,
        string dataSet,
        int[] values,
        (string De, string Coc)[] map,
        int userIdInt,
        Guid userTid,
        bool useTraining,
        bool success,
        string response)
    {
        const string insertSql = """
            INSERT INTO DHIS_LogT
                (dataElement, period, orgUnit,
                 categoryOptionCombo, attributeOptionCombo,
                 DataValue, HealthFacilityID,
                 ActivityDate, UserID,
                 HasChanged, SubmittedUsingID, SuccessID,
                 DataSet, UseTraining, SentByUserTID, Dhis2Response)
            VALUES
                (@De, @Period, @OrgUnit,
                 @Coc, @Aoc,
                 @Val, @HfId,
                 @ActivityDate, @UserId,
                 0, 2, @SuccessId,
                 @DataSet, @UseTraining, @UserTid, @Response)
            """;

        double activityDate = DateTime.UtcNow.ToOADate();
        int    successId    = success ? 1 : 0;

        for (int i = 0; i < map.Length && i < values.Length; i++)
        {
            await using var cmd = new SqlCommand(insertSql, conn);
            cmd.Parameters.AddWithValue("@De",          map[i].De);
            cmd.Parameters.AddWithValue("@Period",       fac.Period);
            cmd.Parameters.AddWithValue("@OrgUnit",      fac.Uid);
            cmd.Parameters.AddWithValue("@Coc",          map[i].Coc);
            cmd.Parameters.AddWithValue("@Aoc",          DefaultAoc);
            cmd.Parameters.AddWithValue("@Val",          values[i]);
            cmd.Parameters.AddWithValue("@HfId",         fac.FacilityId);
            cmd.Parameters.AddWithValue("@ActivityDate", activityDate);
            cmd.Parameters.AddWithValue("@UserId",       userIdInt);
            cmd.Parameters.AddWithValue("@SuccessId",    successId);
            cmd.Parameters.AddWithValue("@DataSet",      dataSet);
            cmd.Parameters.AddWithValue("@UseTraining",  useTraining);
            cmd.Parameters.AddWithValue("@UserTid",      userTid == Guid.Empty
                                                             ? DBNull.Value
                                                             : (object)userTid);
            cmd.Parameters.AddWithValue("@Response",     response.Length > 4000
                                                             ? response[..4000]
                                                             : response);
            await cmd.ExecuteNonQueryAsync();
        }
    }

    // ── Excel preview helpers ─────────────────────────────────────────────────

    private static void FillCaseFindingSheet(XLWorkbook wb, FacilityCache fac)
    {
        var ws = wb.Worksheets.Worksheet(2);

        // Headers
        ws.Cell("D8").SetValue(fac.FacilityName);
        ws.Cell("N8").SetValue(fac.CfQuarter.ToString());
        ws.Cell("Q8").SetValue(fac.CfYear.ToString());
        ws.Cell("N9").SetValue(DateTime.Now.ToString("dd/MM/yyyy"));

        int[] v = fac.CfValues;
        // Block 1: Case types (rows 13-15)
        ws.Cell("I13").SetValue(v[0]);  ws.Cell("K13").SetValue(v[1]);  ws.Cell("M13").SetValue(v[2]);  ws.Cell("O13").SetValue(v[3]);
        ws.Cell("I14").SetValue(v[4]);  ws.Cell("K14").SetValue(v[5]);  ws.Cell("M14").SetValue(v[6]);  ws.Cell("O14").SetValue(v[7]);
        ws.Cell("I15").SetValue(v[8]);  ws.Cell("K15").SetValue(v[9]);  ws.Cell("M15").SetValue(v[10]); ws.Cell("O15").SetValue(v[11]);
        // Block 2: Age/sex — male (row 19)
        ws.Cell("D19").SetValue(v[12]); ws.Cell("E19").SetValue(v[13]); ws.Cell("F19").SetValue(v[14]); ws.Cell("G19").SetValue(v[15]);
        ws.Cell("H19").SetValue(v[16]); ws.Cell("I19").SetValue(v[17]); ws.Cell("J19").SetValue(v[18]); ws.Cell("L19").SetValue(v[19]);
        ws.Cell("N19").SetValue(v[20]); ws.Cell("P19").SetValue(v[21]);
        // Block 2: Age/sex — female (row 20)
        ws.Cell("D20").SetValue(v[22]); ws.Cell("E20").SetValue(v[23]); ws.Cell("F20").SetValue(v[24]); ws.Cell("G20").SetValue(v[25]);
        ws.Cell("H20").SetValue(v[26]); ws.Cell("I20").SetValue(v[27]); ws.Cell("J20").SetValue(v[28]); ws.Cell("L20").SetValue(v[29]);
        ws.Cell("N20").SetValue(v[30]); ws.Cell("P20").SetValue(v[31]);
        // Block 3: Lab activity
        ws.Cell("B24").SetValue(v[32]); ws.Cell("E24").SetValue(v[33]);
        // Block 4: HIV activities
        ws.Cell("I24").SetValue(v[34]); ws.Cell("M24").SetValue(v[35]); ws.Cell("O24").SetValue(v[36]); ws.Cell("Q24").SetValue(v[37]);
        // Block 5: Diagnostic methods
        ws.Cell("J27").SetValue(v[38]); ws.Cell("L27").SetValue(v[39]); ws.Cell("N27").SetValue(v[40]); ws.Cell("P27").SetValue(v[41]); ws.Cell("R27").SetValue(v[42]);
        ws.Cell("J28").SetValue(v[43]); ws.Cell("L28").SetValue(v[44]); ws.Cell("N28").SetValue(v[45]); ws.Cell("P28").SetValue(v[46]);
        // Block 6: HIV+ by age/sex — male (row 32), female (row 33)
        ws.Cell("D32").SetValue(v[48]); ws.Cell("E32").SetValue(v[49]); ws.Cell("F32").SetValue(v[50]); ws.Cell("G32").SetValue(v[51]);
        ws.Cell("H32").SetValue(v[52]); ws.Cell("I32").SetValue(v[53]); ws.Cell("J32").SetValue(v[54]); ws.Cell("L32").SetValue(v[55]);
        ws.Cell("N32").SetValue(v[56]); ws.Cell("P32").SetValue(v[57]);
        ws.Cell("D33").SetValue(v[58]); ws.Cell("E33").SetValue(v[59]); ws.Cell("F33").SetValue(v[60]); ws.Cell("G33").SetValue(v[61]);
        ws.Cell("H33").SetValue(v[62]); ws.Cell("I33").SetValue(v[63]); ws.Cell("J33").SetValue(v[64]); ws.Cell("L33").SetValue(v[65]);
        ws.Cell("N33").SetValue(v[66]); ws.Cell("P33").SetValue(v[67]);
        // Block 7: HIV+ on ART by age/sex — male (row 37), female (row 38)
        ws.Cell("D37").SetValue(v[68]); ws.Cell("E37").SetValue(v[69]); ws.Cell("F37").SetValue(v[70]); ws.Cell("G37").SetValue(v[71]);
        ws.Cell("H37").SetValue(v[72]); ws.Cell("I37").SetValue(v[73]); ws.Cell("J37").SetValue(v[74]); ws.Cell("L37").SetValue(v[75]);
        ws.Cell("N37").SetValue(v[76]); ws.Cell("P37").SetValue(v[77]);
        ws.Cell("D38").SetValue(v[78]); ws.Cell("E38").SetValue(v[79]); ws.Cell("F38").SetValue(v[80]); ws.Cell("G38").SetValue(v[81]);
        ws.Cell("H38").SetValue(v[82]); ws.Cell("I38").SetValue(v[83]); ws.Cell("J38").SetValue(v[84]); ws.Cell("L38").SetValue(v[85]);
        ws.Cell("N38").SetValue(v[86]); ws.Cell("P38").SetValue(v[87]);
    }

    private static void FillSputumConversionSheet(XLWorkbook wb, FacilityCache fac)
    {
        var ws = wb.Worksheets.Worksheet(3);
        ws.Cell("D8").SetValue(fac.FacilityName);
        ws.Cell("L8").SetValue(fac.ScQuarter.ToString());
        ws.Cell("P8").SetValue(fac.ScYear.ToString());
        ws.Cell("N9").SetValue(DateTime.Now.ToString("dd/MM/yyyy"));

        int[] v = fac.CfValues;
        int sc_NewPBC = v[88], sc_SmearND = v[89], sc_2Months = v[90], sc_3Months = v[91];
        ws.Cell("A14").SetValue(sc_NewPBC);
        ws.Cell("F14").SetValue(sc_SmearND);
        ws.Cell("J14").SetValue(sc_2Months);
        ws.Cell("M14").SetValue(sc_3Months);
    }

    private static void FillTreatmentOutcomeSheet(XLWorkbook wb, FacilityCache fac)
    {
        var ws = wb.Worksheets.Worksheet(4);
        ws.Cell("D8").SetValue(fac.FacilityName);
        ws.Cell("P8").SetValue(fac.ToQuarter.ToString());
        ws.Cell("W8").SetValue(fac.ToYear.ToString());
        ws.Cell("P9").SetValue(DateTime.Now.ToString("dd/MM/yyyy"));

        int[] v = fac.ToValues;
        // Block 1: TB treatment outcomes (rows 16-21)
        ws.Cell("H16").SetValue(v[0]);  ws.Cell("I16").SetValue(v[1]);
        ws.Cell("J16").SetValue(v[2]);  ws.Cell("K16").SetValue(v[3]);
        ws.Cell("L16").SetValue(v[4]);  ws.Cell("M16").SetValue(v[5]);
        ws.Cell("N16").SetValue(v[6]);  ws.Cell("O16").SetValue(v[7]);
        ws.Cell("P16").SetValue(v[8]);  ws.Cell("Q16").SetValue(v[9]);
        ws.Cell("R16").SetValue(v[10]); ws.Cell("S16").SetValue(v[11]);
        ws.Cell("T16").SetValue(v[12]); ws.Cell("U16").SetValue(v[13]);

        ws.Cell("H17").SetValue(v[14]); ws.Cell("I17").SetValue(v[15]);
        ws.Cell("L17").SetValue(v[16]); ws.Cell("M17").SetValue(v[17]);
        ws.Cell("N17").SetValue(v[18]); ws.Cell("O17").SetValue(v[19]);
        ws.Cell("P17").SetValue(v[20]); ws.Cell("Q17").SetValue(v[21]);
        ws.Cell("R17").SetValue(v[22]); ws.Cell("S17").SetValue(v[23]);
        ws.Cell("T17").SetValue(v[24]); ws.Cell("U17").SetValue(v[25]);

        ws.Cell("H18").SetValue(v[26]); ws.Cell("I18").SetValue(v[27]);
        ws.Cell("J18").SetValue(v[28]); ws.Cell("K18").SetValue(v[29]);
        ws.Cell("L18").SetValue(v[30]); ws.Cell("M18").SetValue(v[31]);
        ws.Cell("N18").SetValue(v[32]); ws.Cell("O18").SetValue(v[33]);
        ws.Cell("P18").SetValue(v[34]); ws.Cell("Q18").SetValue(v[35]);
        ws.Cell("R18").SetValue(v[36]); ws.Cell("S18").SetValue(v[37]);
        ws.Cell("T18").SetValue(v[38]); ws.Cell("U18").SetValue(v[39]);

        ws.Cell("G19").SetValue(v[40]); ws.Cell("J19").SetValue(v[41]); ws.Cell("L19").SetValue(v[42]);
        ws.Cell("N19").SetValue(v[43]); ws.Cell("P19").SetValue(v[44]); ws.Cell("R19").SetValue(v[45]); ws.Cell("T19").SetValue(v[46]);

        ws.Cell("G20").SetValue(v[47]); ws.Cell("J20").SetValue(v[48]); ws.Cell("L20").SetValue(v[49]);
        ws.Cell("N20").SetValue(v[50]); ws.Cell("P20").SetValue(v[51]); ws.Cell("R20").SetValue(v[52]); ws.Cell("T20").SetValue(v[53]);

        ws.Cell("G21").SetValue(v[54]); ws.Cell("J21").SetValue(v[55]); ws.Cell("L21").SetValue(v[56]);
        ws.Cell("N21").SetValue(v[57]); ws.Cell("P21").SetValue(v[58]); ws.Cell("R21").SetValue(v[59]); ws.Cell("T21").SetValue(v[60]);

        // Block 2: HIV activities
        ws.Cell("E26").SetValue(v[61]); ws.Cell("I26").SetValue(v[62]);
        ws.Cell("P26").SetValue(v[63]); ws.Cell("V26").SetValue(v[64]);

        // Block 3: HIV+ outcomes (row 31)
        ws.Cell("G31").SetValue(v[65]); ws.Cell("J31").SetValue(v[66]); ws.Cell("L31").SetValue(v[67]);
        ws.Cell("N31").SetValue(v[68]); ws.Cell("P31").SetValue(v[69]); ws.Cell("R31").SetValue(v[70]); ws.Cell("T31").SetValue(v[71]);

        // Block 4: Children <15 (row 36)
        ws.Cell("G36").SetValue(v[72]); ws.Cell("J36").SetValue(v[73]); ws.Cell("L36").SetValue(v[74]);
        ws.Cell("N36").SetValue(v[75]); ws.Cell("P36").SetValue(v[76]); ws.Cell("R36").SetValue(v[77]); ws.Cell("T36").SetValue(v[78]);

        // Block 5: Adolescents 10–19 (row 41)
        ws.Cell("G41").SetValue(v[79]); ws.Cell("J41").SetValue(v[80]); ws.Cell("L41").SetValue(v[81]);
        ws.Cell("N41").SetValue(v[82]); ws.Cell("P41").SetValue(v[83]); ws.Cell("R41").SetValue(v[84]); ws.Cell("T41").SetValue(v[85]);
    }

    // =========================================================================
    //  GET /api/dhis2/tb-read-lfa
    // =========================================================================
    /// <summary>
    /// Streams SSE progress events while fetching per-facility TB report data from
    /// DHIS2 for the selected facilities and periods, then builds the LFA Verification
    /// Excel workbook.  One row is written per (period × facility) — data is NOT
    /// aggregated, unlike tb-read-ntp.  On completion emits a download token.
    /// </summary>
    [HttpGet("tb-read-lfa")]
    public async Task ReadLfaFromDhis2(
        [FromQuery] List<string> periods,
        [FromQuery] List<int> facilityIds)
    {
        var ct = HttpContext.RequestAborted;

        // ── Input validation ─────────────────────────────────────────────────
        if (periods is null || periods.Count == 0)
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "At least one period is required." }); return; }
        if (facilityIds is null || facilityIds.Count == 0)
        { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "No facilities selected." }); return; }

        var periodRegex = new System.Text.RegularExpressions.Regex(@"^(\d{4})Q([1-4])$",
            System.Text.RegularExpressions.RegexOptions.None);
        var parsedPeriods = new List<(int Quarter, int Year, string Raw)>(periods.Count);
        foreach (var raw in periods)
        {
            var m = periodRegex.Match(raw ?? "");
            if (!m.Success)
            { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = $"Invalid period '{raw}'. Expected format: YYYYQn." }); return; }
            int y = int.Parse(m.Groups[1].Value);
            int q = int.Parse(m.Groups[2].Value);
            if (y is < 2000 or > 2100)
            { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = $"Period year '{y}' is out of range." }); return; }
            parsedPeriods.Add((q, y, raw!));
        }

        int.TryParse(User.FindFirstValue("facility_id"),   out var facilityId);
        int.TryParse(User.FindFirstValue("county_id"),     out var countyId);
        int.TryParse(User.FindFirstValue("state_id"),      out var stateId);
        int.TryParse(User.FindFirstValue("is_super_user"), out var isSuperUser);

        bool   useTraining = _config.GetValue<bool>("Dhis2:UseTraining", true);
        string section     = useTraining ? "Dhis2:Training" : "Dhis2:Production";
        string dhisBaseUrl = (_config[$"{section}:Url"] ?? string.Empty).TrimEnd('/');
        string dhisUser    = _config[$"{section}:Username"] ?? string.Empty;
        string dhisPwd     = _config[$"{section}:Password"] ?? string.Empty;

        if (string.IsNullOrWhiteSpace(dhisBaseUrl))
        { Response.StatusCode = 500; await Response.WriteAsJsonAsync(new { error = "DHIS2 URL is not configured." }); return; }

        // Resolve facilities (with SubRec) before switching to SSE mode
        List<LfaFacilityRow> selectedFacilities;
        List<string>         uids;
        try
        {
            await using var connCheck = new SqlConnection(_connectionString);
            await connCheck.OpenAsync(ct);
            var scopeFacilities = await GetLfaFacilitiesInScopeAsync(
                connCheck, facilityId, countyId, stateId, isSuperUser == 1);
            selectedFacilities = scopeFacilities
                .Where(f => facilityIds.Contains(f.FacilityId)).ToList();
            if (selectedFacilities.Count == 0)
            { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "No accessible facilities match the selection." }); return; }
            uids = selectedFacilities
                .Where(f => !string.IsNullOrWhiteSpace(f.Uid))
                .Select(f => f.Uid!).Distinct().ToList();
            if (uids.Count == 0)
            { Response.StatusCode = 400; await Response.WriteAsJsonAsync(new { error = "None of the selected facilities have DHIS2 UIDs configured." }); return; }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error resolving facilities in tb-read-lfa");
            Response.StatusCode = 500;
            await Response.WriteAsJsonAsync(new { error = "Failed to resolve facility list." });
            return;
        }

        // ── SSE response setup ────────────────────────────────────────────────
        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.Append("Cache-Control", "no-cache, no-store");
        Response.Headers.Append("X-Accel-Buffering", "no");
        HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        const int totalSteps = 4;
        int step = 0;

        async Task Emit(object payload)
        {
            var json = JsonSerializer.Serialize(payload, SseJsonOptions);
            await Response.WriteAsync($"data: {json}\n\n", ct);
            await Response.Body.FlushAsync(ct);
        }

        async Task Progress(string label)
        {
            step++;
            await Emit(new { step, total = totalSteps, label });
        }

        try
        {
            var httpClient = _httpFactory.CreateClient("dhis2");
            var authBytes  = Encoding.ASCII.GetBytes($"{dhisUser}:{dhisPwd}");
            httpClient.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Basic", Convert.ToBase64String(authBytes));

            string periodParams = string.Join("&",
                parsedPeriods.Select(p => $"period={Uri.EscapeDataString(p.Raw)}"));
            string ouParams = string.Join("&",
                uids.Select(u => $"orgUnit={Uri.EscapeDataString(u)}"));

            // Per-(de, coc, orgUnit, period) dictionaries — no aggregation across facilities
            var cfRaw = new Dictionary<(string De, string Coc, string OrgUnit, string Period), int>(capacity: 5000);
            var toRaw = new Dictionary<(string De, string Coc, string OrgUnit, string Period), int>(capacity: 3000);

            await Progress("Fetching Case Finding & Sputum Conversion data from DHIS2\u2026");
            await FetchPerFacilityAsync(httpClient,
                $"{dhisBaseUrl}?dataSet={CfDataSet}&{periodParams}&{ouParams}&children=false",
                cfRaw);

            await Progress("Processing Case Finding data\u2026");
            // CF and SC share the same dataset — data already in cfRaw.

            await Progress("Fetching Treatment Outcome data from DHIS2\u2026");
            await FetchPerFacilityAsync(httpClient,
                $"{dhisBaseUrl}?dataSet={ToDataSet}&{periodParams}&{ouParams}&children=false",
                toRaw);

            await Progress("Building LFA Verification Report\u2026");

            string templatePath = Path.Combine(
                _env.ContentRootPath, "Templates", "Template_LFA_Verification_Report.xlsx");
            if (!System.IO.File.Exists(templatePath))
            { await Emit(new { error = "LFA report template not found on server." }); return; }

            var wb     = new XLWorkbook(templatePath);
            var cfMap  = ActiveCfMap;
            FillLfaWorkbook(wb, selectedFacilities, parsedPeriods, cfRaw, toRaw, cfMap);

            using var ms = new MemoryStream();
            wb.SaveAs(ms);
            byte[] excelBytes = ms.ToArray();

            string geoLabel = selectedFacilities.Count == 1
                ? selectedFacilities[0].FacilityName
                : selectedFacilities.Select(f => f.County).Distinct().Count() == 1
                    ? selectedFacilities[0].County
                    : selectedFacilities[0].State;

            string periodLabel = parsedPeriods.Count == 1
                ? parsedPeriods[0].Raw
                : $"{parsedPeriods[0].Raw}-{parsedPeriods[^1].Raw}";

            static char SafeChar(char c) =>
                c is '"' or '\\' or '/' or ':' or '*' or '?' or '<' or '>' or '|' ? '_' : c;

            string safeGeo    = new string(geoLabel.Select(SafeChar).Take(60).ToArray()).Trim();
            string safePeriod = new string(periodLabel.Select(SafeChar).ToArray());
            string filename   = $"{safeGeo}_LFA_Verification_{FormatDhis2PeriodForFilename(safePeriod)}_DHIS.xlsx";

            _logger.LogInformation(
                "tb-read-lfa: user {UserId} fetched [{Periods}] for {N} facilities from DHIS2",
                User.FindFirstValue("user_id"), string.Join(",", periods), uids.Count);

            var token = Guid.NewGuid().ToString("N");
            _cache.Set(token, new Dhis2CacheEntry(excelBytes, filename),
                new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5) });
            await Emit(new { done = true, token, filename, step = totalSteps, total = totalSteps });
        }
        catch (OperationCanceledException) { return; }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in tb-read-lfa for periods [{Periods}]", string.Join(",", periods));
            try { await Emit(new { error = "An internal error occurred reading data from DHIS2." }); } catch { }
        }
    }

    // =========================================================================
    //  GET /api/dhis2/tb-read-lfa-download?token=<token>
    // =========================================================================
    [HttpGet("tb-read-lfa-download")]
    public IActionResult DownloadReadLfa([FromQuery] string token)
    {
        if (string.IsNullOrEmpty(token) || !Guid.TryParseExact(token, "N", out _))
            return BadRequest(new { error = "Invalid or missing download token." });

        if (!_cache.TryGetValue(token, out Dhis2CacheEntry? entry) || entry is null)
            return NotFound(new { error = "Download token has expired or was not found. Please regenerate the report." });

        _cache.Remove(token);
        return File(entry.Bytes,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            entry.Filename);
    }

    // ── LFA-specific record and helpers ───────────────────────────────────────

    private sealed record LfaFacilityRow(
        int FacilityId, string FacilityName, string Uid,
        string SubRec, string County, string State);

    private static async Task<List<LfaFacilityRow>> GetLfaFacilitiesInScopeAsync(
        SqlConnection conn,
        int facilityId, int countyId, int stateId, bool isSuperUser)
    {
        string whereClause = isSuperUser || (facilityId == 0 && countyId == 0 && stateId == 0)
            ? "1=1"
            : stateId > 0
                ? "hf.StateID = @StateId"
                : countyId > 0
                    ? "hf.CountyID = @CountyId"
                    : "hf.HealthFacilityID = @FacilityId";

        string sql = $"""
            SELECT hf.HealthFacilityID, hf.HealthFacility, hf.UID,
                   COALESCE(sr.SubRec, ''), c.County, s.State
            FROM   HealthFacilityT hf
            INNER JOIN CountyT c  ON c.CountyID  = hf.CountyID
            INNER JOIN StateT  s  ON s.StateID   = hf.StateID
            LEFT  JOIN SubRecT sr ON sr.SubRecID = hf.SubRecID
            WHERE  hf.UID IS NOT NULL AND LTRIM(RTRIM(hf.UID)) <> ''
              AND  {whereClause}
            ORDER BY sr.SubRec, s.State, c.County, hf.HealthFacility
            """;

        await using var cmd = new SqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("@StateId",    stateId);
        cmd.Parameters.AddWithValue("@CountyId",   countyId);
        cmd.Parameters.AddWithValue("@FacilityId", facilityId);

        var list = new List<LfaFacilityRow>();
        await using var rs = await cmd.ExecuteReaderAsync();
        while (await rs.ReadAsync())
        {
            list.Add(new LfaFacilityRow(
                rs.GetInt32(0),
                rs.GetString(1),
                rs.GetString(2),
                rs.IsDBNull(3) ? "" : rs.GetString(3),
                rs.GetString(4),
                rs.GetString(5)));
        }
        return list;
    }

    /// <summary>
    /// Fetches a DHIS2 dataValueSets response and stores each value in
    /// <paramref name="dict"/> keyed by (dataElement, categoryOptionCombo, orgUnit, period).
    /// No aggregation: each (de, coc, orgUnit, period) tuple is kept separately so
    /// callers can look up per-facility, per-quarter values.
    /// </summary>
    private static async Task FetchPerFacilityAsync(
        HttpClient client,
        string url,
        Dictionary<(string De, string Coc, string OrgUnit, string Period), int> dict)
    {
        HttpResponseMessage resp;
        try { resp = await client.GetAsync(url); }
        catch { return; }
        if (!resp.IsSuccessStatusCode) return;

        string json = await resp.Content.ReadAsStringAsync();
        if (json.Length < 10) return;

        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("dataValues", out var dvArr)) return;
            foreach (var dv in dvArr.EnumerateArray())
            {
                string de  = dv.TryGetProperty("dataElement",         out var dp)  ? dp.GetString()  ?? "" : "";
                string coc = dv.TryGetProperty("categoryOptionCombo", out var cp)  ? cp.GetString()  ?? "" : "";
                string ou  = dv.TryGetProperty("orgUnit",             out var op)  ? op.GetString()  ?? "" : "";
                string per = dv.TryGetProperty("period",              out var pp)  ? pp.GetString()  ?? "" : "";
                string vs  = dv.TryGetProperty("value",               out var vp)  ? vp.GetString()  ?? "0" : "0";
                if (string.IsNullOrEmpty(de) || string.IsNullOrEmpty(coc) ||
                    string.IsNullOrEmpty(ou) || string.IsNullOrEmpty(per)) continue;
                int.TryParse(vs, out var val);
                dict[(de, coc, ou, per)] = val;
            }
        }
        catch { }
    }

    /// <summary>
    /// Builds the LFA Verification Excel workbook.
    /// Loops periods × facilities and writes one CF row and one TO row per entry.
    /// Applies totals, conditional formatting, and sheet protection to match the
    /// original reference implementation.
    /// </summary>
    private static void FillLfaWorkbook(
        XLWorkbook wb,
        IReadOnlyList<LfaFacilityRow> facilities,
        IReadOnlyList<(int Quarter, int Year, string Raw)> parsedPeriods,
        Dictionary<(string De, string Coc, string OrgUnit, string Period), int> cfRaw,
        Dictionary<(string De, string Coc, string OrgUnit, string Period), int> toRaw,
        (string De, string Coc)[] cfMap)
    {
        // ── Determine sheet names ─────────────────────────────────────────────
        int cfYear = parsedPeriods[^1].Year;
        int toYear = parsedPeriods[^1].Year;

        bool isWholeYear = parsedPeriods.Count == 4
            && parsedPeriods.Select(p => p.Quarter).OrderBy(q => q).SequenceEqual(new[] { 1, 2, 3, 4 });

        string cfSheetName, toSheetName;
        if (parsedPeriods.Count == 1)
        {
            cfSheetName = $"CF Q{parsedPeriods[0].Quarter} {cfYear}";
            toSheetName = $"TO Q{parsedPeriods[0].Quarter} {toYear}";
        }
        else if (isWholeYear)
        {
            cfSheetName = $"CF {cfYear}";
            toSheetName = $"TO {toYear}";
        }
        else
        {
            int lastQ  = parsedPeriods[^1].Quarter;
            string sem = lastQ <= 2 ? "S1" : "S2";
            cfSheetName = $"CF {sem} {cfYear}";
            toSheetName = $"TO {sem} {toYear}";
        }

        var ws = wb.Worksheet("casefinding");
        var wo = wb.Worksheet("outcome");
        ws.Name = cfSheetName;
        wo.Name = toSheetName;

        // ── Write data rows ───────────────────────────────────────────────────
        // CF data rows start at row 4 (counter starts at 3, increments before use).
        // TO data rows start at row 5 (counter + 1 when counter first reaches 4).
        int counter = 3;

        foreach (var period in parsedPeriods)
        {
            string periodRaw    = period.Raw;
            string quarterDigit = period.Quarter.ToString();
            string yearStr      = period.Year.ToString();

            foreach (var fac in facilities)
            {
                if (string.IsNullOrWhiteSpace(fac.Uid)) continue;
                counter++;

                // ── Extract CF values for this facility + period ───────────────
                int[] cv = new int[cfMap.Length];
                for (int i = 0; i < cfMap.Length; i++)
                    cfRaw.TryGetValue((cfMap[i].De, cfMap[i].Coc, fac.Uid, periodRaw), out cv[i]);

                // ── CF sheet row ──────────────────────────────────────────────
                ws.Cell($"A{counter}").Value = counter - 3;
                ws.Cell($"B{counter}").Value = fac.SubRec;
                ws.Cell($"C{counter}").Value = fac.County;
                ws.Cell($"D{counter}").Value = fac.FacilityName;
                ws.Cell($"E{counter}").Value = yearStr;
                ws.Cell($"F{counter}").Value = quarterDigit;

                // Block 1: Case types
                ws.Cell($"G{counter}").Value = cv[0];  ws.Cell($"H{counter}").Value = cv[1];
                ws.Cell($"I{counter}").Value = cv[2];  ws.Cell($"J{counter}").Value = cv[3];
                ws.Cell($"K{counter}").Value = cv[4];  ws.Cell($"L{counter}").Value = cv[5];
                ws.Cell($"M{counter}").Value = cv[6];  ws.Cell($"N{counter}").Value = cv[7];
                ws.Cell($"O{counter}").Value = cv[8];  ws.Cell($"P{counter}").Value = cv[9];
                ws.Cell($"Q{counter}").Value = cv[10]; ws.Cell($"R{counter}").Value = cv[11];
                ws.Cell($"S{counter}").Value = cv[0] + cv[4] + cv[8];   // Total New
                ws.Cell($"T{counter}").Value = cv[1] + cv[5] + cv[9];   // Total Relapse
                ws.Cell($"U{counter}").Value = (cv[0] + cv[4] + cv[8]) + (cv[1] + cv[5] + cv[9]); // Total New+Relapse

                // Block 2: Age/sex male (cv[12]-cv[21])
                ws.Cell($"V{counter}").Value  = cv[12]; ws.Cell($"W{counter}").Value  = cv[13];
                ws.Cell($"X{counter}").Value  = cv[14]; ws.Cell($"Y{counter}").Value  = cv[15];
                ws.Cell($"Z{counter}").Value  = cv[16]; ws.Cell($"AA{counter}").Value = cv[17];
                ws.Cell($"AB{counter}").Value = cv[18]; ws.Cell($"AC{counter}").Value = cv[19];
                ws.Cell($"AD{counter}").Value = cv[20]; ws.Cell($"AE{counter}").Value = cv[21];

                // Block 2: Age/sex female (cv[22]-cv[31])
                ws.Cell($"AF{counter}").Value = cv[22]; ws.Cell($"AG{counter}").Value = cv[23];
                ws.Cell($"AH{counter}").Value = cv[24]; ws.Cell($"AI{counter}").Value = cv[25];
                ws.Cell($"AJ{counter}").Value = cv[26]; ws.Cell($"AK{counter}").Value = cv[27];
                ws.Cell($"AL{counter}").Value = cv[28]; ws.Cell($"AM{counter}").Value = cv[29];
                ws.Cell($"AN{counter}").Value = cv[30]; ws.Cell($"AO{counter}").Value = cv[31];

                // Block 3: Lab
                ws.Cell($"AP{counter}").Value = cv[32]; // SuspectsSeen
                ws.Cell($"AQ{counter}").Value = cv[33]; // PBCLab

                // Block 5: Diagnostic methods (cv[38]-cv[42]) and positives (cv[43]-cv[46])
                ws.Cell($"AR{counter}").Value = cv[38]; // GeneXpert
                ws.Cell($"AS{counter}").Value = cv[39]; // Microscopy
                ws.Cell($"AT{counter}").Value = cv[40]; // TBLam
                ws.Cell($"AU{counter}").Value = cv[41]; // TrueNat
                ws.Cell($"AV{counter}").Value = cv[42]; // Xray
                ws.Cell($"AW{counter}").FormulaA1 = $"=SUM(AR{counter}+AT{counter}+AU{counter})";
                ws.Cell($"AX{counter}").FormulaA1 = $"=IF(SUM(AR{counter}:AV{counter})=0,0,AW{counter}/SUM(AR{counter}:AV{counter}))";
                ws.Cell($"AX{counter}").Style.NumberFormat.Format = "0.0%";
                ws.Cell($"AY{counter}").Value = cv[43]; // GeneXpert_Pos
                ws.Cell($"AZ{counter}").Value = cv[44]; // Microscopy_Pos
                ws.Cell($"BA{counter}").Value = cv[40]; // TBLam count (intentional — matches reference code note)
                ws.Cell($"BB{counter}").Value = cv[46]; // TrueNat_Pos

                // Block 6: HIV+ by age/sex male (cv[48]-cv[57]) → BC-BL
                ws.Cell($"BC{counter}").Value = cv[48]; ws.Cell($"BD{counter}").Value = cv[49];
                ws.Cell($"BE{counter}").Value = cv[50]; ws.Cell($"BF{counter}").Value = cv[51];
                ws.Cell($"BG{counter}").Value = cv[52]; ws.Cell($"BH{counter}").Value = cv[53];
                ws.Cell($"BI{counter}").Value = cv[54]; ws.Cell($"BJ{counter}").Value = cv[55];
                ws.Cell($"BK{counter}").Value = cv[56]; ws.Cell($"BL{counter}").Value = cv[57];

                // Block 6: HIV+ by age/sex female (cv[58]-cv[67]) → BM-BV
                ws.Cell($"BM{counter}").Value = cv[58]; ws.Cell($"BN{counter}").Value = cv[59];
                ws.Cell($"BO{counter}").Value = cv[60]; ws.Cell($"BP{counter}").Value = cv[61];
                ws.Cell($"BQ{counter}").Value = cv[62]; ws.Cell($"BR{counter}").Value = cv[63];
                ws.Cell($"BS{counter}").Value = cv[64]; ws.Cell($"BT{counter}").Value = cv[65];
                ws.Cell($"BU{counter}").Value = cv[66]; ws.Cell($"BV{counter}").Value = cv[67];

                // Block 4: HIV activities (cv[34]-cv[37]) → BW-BZ
                ws.Cell($"BW{counter}").Value = cv[34]; // TestedHIV
                ws.Cell($"BX{counter}").Value = cv[35]; // TestedHIVPos
                ws.Cell($"BY{counter}").Value = cv[36]; // TestedHIVART
                ws.Cell($"BZ{counter}").Value = cv[37]; // TestedHIVCPT

                // Derived formulas
                ws.Cell($"CA{counter}").FormulaA1 = $"=SUM(V{counter}:AO{counter})";
                ws.Cell($"CB{counter}").FormulaA1 = $"=CA{counter}-U{counter}";
                ws.Cell($"CC{counter}").FormulaA1 = $"=IF(CA{counter}=0,0,BW{counter}/CA{counter})";
                ws.Cell($"CC{counter}").Style.NumberFormat.Format = "0.0%";
                ws.Cell($"CD{counter}").FormulaA1 =
                    $"=IF(AND(BY{counter}=0,BX{counter}=0),\"NA\",IF(BX{counter}=0,0,BY{counter}/BX{counter}))";
                ws.Cell($"CD{counter}").Style.NumberFormat.Format = "0.0%";

                // Block 7: ART HIV+ by age/sex male (cv[68]-cv[77]) → CE-CN
                ws.Cell($"CE{counter}").Value = cv[68]; ws.Cell($"CF{counter}").Value = cv[69];
                ws.Cell($"CG{counter}").Value = cv[70]; ws.Cell($"CH{counter}").Value = cv[71];
                ws.Cell($"CI{counter}").Value = cv[72]; ws.Cell($"CJ{counter}").Value = cv[73];
                ws.Cell($"CK{counter}").Value = cv[74]; ws.Cell($"CL{counter}").Value = cv[75];
                ws.Cell($"CM{counter}").Value = cv[76]; ws.Cell($"CN{counter}").Value = cv[77];

                // Block 7: ART HIV+ by age/sex female (cv[78]-cv[87]) → CO-CX
                ws.Cell($"CO{counter}").Value = cv[78]; ws.Cell($"CP{counter}").Value = cv[79];
                ws.Cell($"CQ{counter}").Value = cv[80]; ws.Cell($"CR{counter}").Value = cv[81];
                ws.Cell($"CS{counter}").Value = cv[82]; ws.Cell($"CT{counter}").Value = cv[83];
                ws.Cell($"CU{counter}").Value = cv[84]; ws.Cell($"CV{counter}").Value = cv[85];
                ws.Cell($"CW{counter}").Value = cv[86]; ws.Cell($"CX{counter}").Value = cv[87];

                // ── TO sheet row ──────────────────────────────────────────────
                int[] tv = new int[ToMap.Length];
                for (int i = 0; i < ToMap.Length; i++)
                    toRaw.TryGetValue((ToMap[i].De, ToMap[i].Coc, fac.Uid, periodRaw), out tv[i]);

                int toRow = counter + 1;

                wo.Cell($"A{toRow}").Value = counter - 3;
                wo.Cell($"B{toRow}").Value = fac.SubRec;
                wo.Cell($"C{toRow}").Value = fac.County;
                wo.Cell($"D{toRow}").Value = fac.FacilityName;
                wo.Cell($"E{toRow}").Value = yearStr;
                wo.Cell($"F{toRow}").Value = quarterDigit;

                // G: total enrolled (new PBC + PCD/EP + relapse, both sexes)
                wo.Cell($"G{toRow}").Value =
                    (tv[0] + tv[14] + tv[26]) + (tv[1] + tv[15] + tv[27]);

                // H: successful treatment (cured + completed, all applicable types)
                wo.Cell($"H{toRow}").Value =
                    (tv[2] + tv[28]) + (tv[4] + tv[16] + tv[30]) +
                    (tv[3] + tv[29]) + (tv[5] + tv[17] + tv[31]);

                // I-L: died, failed, lost, not evaluated
                wo.Cell($"I{toRow}").Value  = (tv[6]  + tv[18] + tv[32]) + (tv[7]  + tv[19] + tv[33]);
                wo.Cell($"J{toRow}").Value  = (tv[8]  + tv[20] + tv[34]) + (tv[9]  + tv[21] + tv[35]);
                wo.Cell($"K{toRow}").Value  = (tv[10] + tv[22] + tv[36]) + (tv[11] + tv[23] + tv[37]);
                wo.Cell($"L{toRow}").Value  = (tv[12] + tv[24] + tv[38]) + (tv[13] + tv[25] + tv[39]);

                // M: success rate
                wo.Cell($"M{toRow}").Style.NumberFormat.Format = "0.0%";
                wo.Cell($"M{toRow}").FormulaA1 =
                    $"=IFERROR(IF(G{toRow}=0,0,H{toRow}/G{toRow}),0)";

                // N-P: HIV activities
                wo.Cell($"N{toRow}").Value = tv[61]; // TestedHIV
                wo.Cell($"O{toRow}").Value = tv[62]; // TestedHIVPos
                wo.Cell($"P{toRow}").Value = tv[63]; // TestedHIVART

                // Q: HIV+ (OBxOcDrbThw / Lhru44pCaDo — denominator for HIV outcomes)
                wo.Cell($"Q{toRow}").Value = tv[65];

                // R-V: HIV+ treatment outcomes
                wo.Cell($"R{toRow}").Value = tv[66] + tv[67]; // Cured + Completed
                wo.Cell($"S{toRow}").Value = tv[68]; // Died
                wo.Cell($"T{toRow}").Value = tv[69]; // Failed
                wo.Cell($"U{toRow}").Value = tv[70]; // Lost to follow-up
                wo.Cell($"V{toRow}").Value = tv[71]; // Not evaluated

                // W: HIV success rate
                wo.Cell($"W{toRow}").Style.NumberFormat.Format = "0.0%";
                wo.Cell($"W{toRow}").FormulaA1 =
                    $"=IFERROR(IF(Q{toRow}=0,0,R{toRow}/Q{toRow}),0)";

                // X-AC: Children (<15 years)
                wo.Cell($"X{toRow}").Value  = tv[72];
                wo.Cell($"Y{toRow}").Value  = tv[73] + tv[74]; // Cured + Completed
                wo.Cell($"Z{toRow}").Value  = tv[75];
                wo.Cell($"AA{toRow}").Value = tv[76];
                wo.Cell($"AB{toRow}").Value = tv[77];
                wo.Cell($"AC{toRow}").Value = tv[78];
                wo.Cell($"AD{toRow}").Style.NumberFormat.Format = "0.0%";
                wo.Cell($"AD{toRow}").FormulaA1 =
                    $"=IFERROR(IF(X{toRow}=0,0,Y{toRow}/X{toRow}),0)";

                // AE-AJ: Adolescents (10–19 years)
                wo.Cell($"AE{toRow}").Value = tv[79];
                wo.Cell($"AF{toRow}").Value = tv[80] + tv[81]; // Cured + Completed
                wo.Cell($"AG{toRow}").Value = tv[82];
                wo.Cell($"AH{toRow}").Value = tv[83];
                wo.Cell($"AI{toRow}").Value = tv[84];
                wo.Cell($"AJ{toRow}").Value = tv[85];
                wo.Cell($"AK{toRow}").Style.NumberFormat.Format = "0.0%";
                wo.Cell($"AK{toRow}").FormulaA1 =
                    $"=IFERROR(IF(AE{toRow}=0,0,AF{toRow}/AE{toRow}),0)";
            }
        }

        // ── TO sheet header cells ─────────────────────────────────────────────
        if (parsedPeriods.Count == 1)
        {
            wo.Cell("F3").Value = $"Q{parsedPeriods[0].Quarter} of {toYear}";
            wo.Cell("G4").Value = $"Cases registered in Q{parsedPeriods[0].Quarter} of {toYear} (New and Relapse)";
        }
        else if (isWholeYear)
        {
            wo.Cell("F3").Value = $"Year {toYear}";
            wo.Cell("G4").Value = $"Cases registered in {toYear} (New and Relapse)";
        }
        else
        {
            int    lastQ  = parsedPeriods[^1].Quarter;
            string semLbl = lastQ <= 2 ? "Semester 1" : "Semester 2";
            wo.Cell("F3").Value = $"{semLbl} of {toYear}";
            wo.Cell("G4").Value = $"Cases registered in {semLbl} of {toYear} (New and Relapse)";
        }

        // ── Totals and formatting (only when data rows exist) ─────────────────
        int cfTotalRow = counter + 1;
        int toTotalRow = counter + 2;

        if (counter > 3)
        {
            // CF SUM columns
            string[] cfSumCols = {
                "G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U",
                "V","W","X","Y","Z","AA","AB","AC","AD","AE","AF","AG","AH","AI","AJ","AK","AL","AM","AN","AO",
                "AP","AQ","AR","AS","AT","AU","AV",
                "AY","AZ","BA","BB",
                "BC","BD","BE","BF","BG","BH","BI","BJ","BK","BL",
                "BM","BN","BO","BP","BQ","BR","BS","BT","BU","BV",
                "BW","BX","BY","BZ","CA","CB",
                "CE","CF","CG","CH","CI","CJ","CK","CL","CM","CN",
                "CO","CP","CQ","CR","CS","CT","CU","CV","CW","CX"
            };
            foreach (var col in cfSumCols)
                ws.Cell($"{col}{cfTotalRow}").FormulaA1 = $"=SUM({col}4:{col}{counter})";

            // AW and AX total row formulas
            ws.Cell($"AW{cfTotalRow}").FormulaA1 = $"=SUM(AW4:AW{counter})";
            ws.Cell($"AX{cfTotalRow}").FormulaA1 =
                $"=IF(SUM(AR{cfTotalRow}:AV{cfTotalRow})=0,0,AW{cfTotalRow}/SUM(AR{cfTotalRow}:AV{cfTotalRow}))";
            ws.Cell($"AX{cfTotalRow}").Style.NumberFormat.Format = "0.0%";
            ws.Cell($"CC{cfTotalRow}").FormulaA1 =
                $"=IFERROR(IF(CA{cfTotalRow}=0,0,BW{cfTotalRow}/CA{cfTotalRow}),0)";
            ws.Cell($"CD{cfTotalRow}").FormulaA1 =
                $"=IFERROR(IF(BX{cfTotalRow}=0,0,BY{cfTotalRow}/BY{cfTotalRow}),0)";
            ws.Range($"CC4:CD{cfTotalRow}").Style.NumberFormat.Format = "0.0%";

            ws.Range($"G{cfTotalRow}:CX{cfTotalRow}").Style.Font.Bold = true;
            ws.Range($"G{cfTotalRow}:CX{cfTotalRow}").Style.Border.TopBorder    = XLBorderStyleValues.Thin;
            ws.Range($"G{cfTotalRow}:CX{cfTotalRow}").Style.Border.BottomBorder = XLBorderStyleValues.Thin;

            // TO SUM columns (data rows: 5 to counter+1)
            int toDataEnd = counter + 1;
            string[] toSumCols = {
                "G","H","I","J","K","L","N","O","P","Q","R","S","T","U","V",
                "X","Y","Z","AA","AB","AC","AE","AF","AG","AH","AI","AJ"
            };
            foreach (var col in toSumCols)
                wo.Cell($"{col}{toTotalRow}").FormulaA1 = $"=SUM({col}5:{col}{toDataEnd})";

            wo.Cell($"M{toTotalRow}").FormulaA1 =
                $"=IFERROR(IF(G{toTotalRow}=0,0,H{toTotalRow}/G{toTotalRow}),0)";
            wo.Cell($"W{toTotalRow}").FormulaA1 =
                $"=IFERROR(IF(Q{toTotalRow}=0,0,R{toTotalRow}/Q{toTotalRow}),0)";
            wo.Cell($"AD{toTotalRow}").FormulaA1 =
                $"=IFERROR(IF(X{toTotalRow}=0,0,Y{toTotalRow}/X{toTotalRow}),0)";
            wo.Cell($"AK{toTotalRow}").FormulaA1 =
                $"=IFERROR(IF(AE{toTotalRow}=0,0,AF{toTotalRow}/AE{toTotalRow}),0)";

            wo.Range($"M5:M{toTotalRow}").Style.NumberFormat.Format  = "0.0%";
            wo.Range($"W5:W{toTotalRow}").Style.NumberFormat.Format  = "0.0%";
            wo.Range($"AD5:AD{toTotalRow}").Style.NumberFormat.Format = "0.0%";
            wo.Range($"AK5:AK{toTotalRow}").Style.NumberFormat.Format = "0.0%";

            wo.Range($"G{toTotalRow}:AK{toTotalRow}").Style.Font.Bold = true;
            wo.Range($"G{toTotalRow}:AK{toTotalRow}").Style.Border.TopBorder    = XLBorderStyleValues.Thin;
            wo.Range($"G{toTotalRow}:AK{toTotalRow}").Style.Border.BottomBorder = XLBorderStyleValues.Thin;
        }

        // ── CF conditional formatting ─────────────────────────────────────────
        ws.Range($"CC4:CC{cfTotalRow}").AddConditionalFormat().WhenBetween(0.9, 1).Fill.SetBackgroundColor(XLColor.DarkGreen);
        ws.Range($"CC4:CC{cfTotalRow}").AddConditionalFormat().WhenBetween(0.7, 0.8999).Fill.SetBackgroundColor(XLColor.Yellow);
        ws.Range($"CC4:CC{cfTotalRow}").AddConditionalFormat().WhenBetween(0, 0.6999).Fill.SetBackgroundColor(XLColor.Red);
        ws.Range($"CC4:CC{cfTotalRow}").AddConditionalFormat().WhenLessThan(0).Fill.SetBackgroundColor(XLColor.Red);
        ws.Range($"CC4:CC{cfTotalRow}").AddConditionalFormat().WhenGreaterThan(1).Fill.SetBackgroundColor(XLColor.Red);
        ws.Range($"CD4:CD{cfTotalRow}").AddConditionalFormat().WhenBetween(0.93, 1).Fill.SetBackgroundColor(XLColor.DarkGreen);
        ws.Range($"CD4:CD{cfTotalRow}").AddConditionalFormat().WhenBetween(0.9, 0.92999).Fill.SetBackgroundColor(XLColor.Yellow);
        ws.Range($"CD4:CD{cfTotalRow}").AddConditionalFormat().WhenBetween(0, 0.8999).Fill.SetBackgroundColor(XLColor.Red);
        ws.Range($"CD4:CD{cfTotalRow}").AddConditionalFormat().WhenLessThan(0).Fill.SetBackgroundColor(XLColor.Red);
        ws.Range($"CD4:CD{cfTotalRow}").AddConditionalFormat().WhenGreaterThan(1).Fill.SetBackgroundColor(XLColor.Red);

        // ── TO conditional formatting ─────────────────────────────────────────
        foreach (var col in new[] { "M", "W", "AD", "AK" })
        {
            wo.Range($"{col}5:{col}{toTotalRow}").AddConditionalFormat().WhenBetween(0.85, 1).Fill.SetBackgroundColor(XLColor.DarkGreen);
            wo.Range($"{col}5:{col}{toTotalRow}").AddConditionalFormat().WhenBetween(0.75, 0.8499).Fill.SetBackgroundColor(XLColor.Yellow);
            wo.Range($"{col}5:{col}{toTotalRow}").AddConditionalFormat().WhenBetween(0, 0.74999).Fill.SetBackgroundColor(XLColor.Red);
            wo.Range($"{col}5:{col}{toTotalRow}").AddConditionalFormat().WhenLessThan(0).Fill.SetBackgroundColor(XLColor.Red);
            wo.Range($"{col}5:{col}{toTotalRow}").AddConditionalFormat().WhenGreaterThan(1).Fill.SetBackgroundColor(XLColor.Red);
        }

        // ── CF sheet styling ──────────────────────────────────────────────────
        ws.Range($"E4:CX{cfTotalRow}").Style.Alignment.Vertical   = XLAlignmentVerticalValues.Center;
        ws.Range($"E4:CX{cfTotalRow}").Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
        ws.Range($"A1:CX{cfTotalRow}").Style.Font.FontName        = "Segoe UI";
        ws.Range("A1:CX2").Style.Fill.BackgroundColor = XLColor.FromHtml("#00B0F0");
        ws.Range("A3:CX3").Style.Fill.BackgroundColor = XLColor.FromHtml("#FFC000");

        ws.SheetView.FreezeRows(3);
        ws.SheetView.FreezeColumns(6);
        ws.PageSetup.PageOrientation = XLPageOrientation.Landscape;
        ws.PageSetup.PaperSize       = XLPaperSize.A4Paper;
        ws.PageSetup.Footer.Left.AddText(
            $"Exported from the eTBr Server on {DateTime.Now:dddd, dd MMM yyyy HH:mm:ss}");

        // CF protection: unlock data cells, lock headers + formula cols
        ws.Range($"G4:CX{counter}").Style.Protection.SetLocked(false);
        ws.Range($"A1:F{counter}").Style.Protection.SetLocked(true);
        ws.Range($"CC1:CD{counter}").Style.Protection.SetLocked(true);
        ws.Range($"AW4:AX{counter}").Style.Protection.SetLocked(true);
        var cfProt = ws.Protect("0000001");
        cfProt.AllowedElements = XLSheetProtectionElements.InsertRows
            | XLSheetProtectionElements.SelectUnlockedCells
            | XLSheetProtectionElements.InsertColumns;

        // ── TO sheet styling ──────────────────────────────────────────────────
        wo.Range($"F5:AK{toTotalRow}").Style.Alignment.Vertical   = XLAlignmentVerticalValues.Center;
        wo.Range($"F5:AK{toTotalRow}").Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Center;
        wo.Range($"A1:AK{toTotalRow}").Style.Font.FontName        = "Segoe UI";

        wo.SheetView.FreezeRows(4);
        wo.SheetView.FreezeColumns(5);
        wo.PageSetup.PageOrientation = XLPageOrientation.Landscape;
        wo.PageSetup.PaperSize       = XLPaperSize.A4Paper;
        wo.PageSetup.AddVerticalPageBreak(29);
        wo.PageSetup.Footer.Left.AddText(
            $"Exported from the eTBr Server on {DateTime.Now:dddd, dd MMM yyyy HH:mm:ss}");

        // TO protection: unlock outcome data cells
        int toDataEndProtect = counter + 1;
        wo.Range($"F5:K{toDataEndProtect}").Style.Protection.SetLocked(false);
        wo.Range($"M5:U{toDataEndProtect}").Style.Protection.SetLocked(false);
        wo.Range($"W5:AB{toDataEndProtect}").Style.Protection.SetLocked(false);
        var toProt = wo.Protect("0000001");
        toProt.AllowedElements = XLSheetProtectionElements.InsertRows
            | XLSheetProtectionElements.SelectUnlockedCells
            | XLSheetProtectionElements.InsertColumns;
    }
}
