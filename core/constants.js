// GENERATED FILE — DO NOT EDIT.
//
// Produced by tools/export_constants.py from trip_trace.py, stations.py, scorer.py, and
// trip_board_parser.py. Python remains the single source of truth for every value here.
//
// Regenerate:  python3 tools/export_constants.py
// Verify:      python3 tools/export_constants.py --check
//
// Hand-editing this file puts the port out of agreement with the reference implementation, which
// the differential tests will catch — but only after someone has already shipped a wrong number.
// Change trip_trace.py instead.
//
// Emitted as a runnable ES module rather than TypeScript so it can be executed and diffed against
// Python today, with no build step. Object.freeze is the runtime equivalent of `as const`, and
// `tsc --checkJs` type-checks it unchanged when the toolchain arrives.


/** SAFTE-style parameter set. Snapshot these into every trace for reproducibility. */
export const MODEL_PARAMS = Object.freeze({
  "reservoir_capacity_units": 2880,
  "depletion_slope_units_per_min": 0.5,
  "max_sleep_intensity_units_per_min": 4.4,
  "circadian_a1_pct": 7,
  "circadian_a2_pct": 5,
  "phase_delay_days_per_hour": 1.0,
  "phase_advance_days_per_hour": 1.5,
  "shiftwork_slowdown_factor": 2.6,
  "body_clock_drift_cap_hours_per_day": 1.0,
  "wocl_body_clock_start": "02:00",
  "wocl_body_clock_end": "06:00",
  "reservoir_fatigue_threshold": 75,
  "effectiveness_fatigue_threshold": 77,
  "daytime_sleep_efficiency": 0.78,
  "nocturnal_sleep_efficiency": 0.95,
  "bunk_quality_factor": 0.65
});

/** Operational risk bands. Thresholds are shared with the Python `band_for`. */
export const EFFECTIVENESS_BANDS = Object.freeze([
  {
    "band": "green",
    "low": 90.0,
    "high": 100.01,
    "code": "\ud83d\udfe2",
    "bac": "negligible"
  },
  {
    "band": "yellow",
    "low": 85.0,
    "high": 90.0,
    "code": "\ud83d\udfe1",
    "bac": "~0.01-0.02"
  },
  {
    "band": "orange",
    "low": 80.0,
    "high": 85.0,
    "code": "\ud83d\udfe0",
    "bac": "~0.03-0.04"
  },
  {
    "band": "red",
    "low": 75.0,
    "high": 80.0,
    "code": "\ud83d\udd34",
    "bac": "~0.05"
  },
  {
    "band": "purple",
    "low": 0.0,
    "high": 75.0,
    "code": "\ud83d\udfe3",
    "bac": "~0.08-0.10"
  }
]);

/** Display names for the bands, used by the report and the UI. */
export const BAND_LABELS = Object.freeze({
  "green": "Normal",
  "yellow": "Monitor",
  "orange": "Elevated",
  "red": "High",
  "purple": "Critical"
});

/** Effectiveness / PVT lapses / hours awake / BAC reference table. */
export const EFFECTIVENESS_BAC_TABLE = Object.freeze([
  [
    98,
    0.2,
    "14:00",
    null
  ],
  [
    94,
    1.0,
    "15:10",
    null
  ],
  [
    90,
    1.5,
    "16:00",
    null
  ],
  [
    80,
    3.0,
    "18:00",
    null
  ],
  [
    77,
    4.0,
    "18:30",
    0.05
  ],
  [
    70,
    5.0,
    "21:00",
    0.08
  ],
  [
    60,
    8.0,
    "40:50",
    null
  ],
  [
    50,
    12.0,
    "42:30",
    null
  ],
  [
    40,
    16.0,
    "64:00",
    null
  ]
]);

/** Spec 2C report allowances and debriefs, in hours. */
export const REPORT_ALLOWANCE_HOURS = Object.freeze({
  "domestic_in_domicile": 1.0,
  "international_in_domicile": 1.5,
  "domestic_away": 1.5,
  "international_away": 2.0
});

export const DEBRIEF_HOURS = Object.freeze({
  "domestic": 0.25,
  "international": 0.5
});

/** Spec 2D augmentation bands for international flying. */
export const AUGMENTATION_RULES = Object.freeze([
  {
    "block_max": 7.75,
    "crew": 2,
    "bunk": false,
    "bunk_target": [
      0.0,
      0.0
    ]
  },
  {
    "block_max": 11.99,
    "crew": 3,
    "bunk": true,
    "bunk_target": [
      1.5,
      3.0
    ]
  },
  {
    "block_max": 99.0,
    "crew": 4,
    "bunk": true,
    "bunk_target": [
      2.5,
      4.5
    ]
  }
]);

/** Spec 3.1 subtractions from a layover to reach a sleep opportunity. */
export const SLEEP_OPPORTUNITY_SUBTRACTIONS = Object.freeze({
  "transport_hours": 1.0,
  "transport_hours_intl": 1.5,
  "wind_down_hours": 1.0,
  "meal_hours": 0.5,
  "pre_report_prep_hours": 1.25
});

/** IPA/UPS contractual rest floors, in hours. */
export const CONTRACT_REST_FLOORS = Object.freeze({
  "domestic": {
    "min": 10.0,
    "reducible_to": 9.5
  },
  "domicile": {
    "min": 10.5,
    "reducible_to": 10.5
  },
  "international": {
    "min": 12.0,
    "reducible_to": 11.5
  }
});

/** Calibration constants owned by scorer.py — see its docstring before touching. */
export const SCORER_CALIBRATION = Object.freeze({
  "step_minutes": 5,
  "circadian_peak_hour": 20.0,
  "second_harmonic_weight": 0.65,
  "second_harmonic_offset_hours": 0.5,
  "sleep_intensity_exponent": 0.5,
  "inertia_minutes": 20.0,
  "inertia_minutes_from_wocl": 30.0,
  "inertia_penalty_points": 9.0
});

/** Parser-local constant: how close to the floor counts as 'near'. */
export const NEAR_FLOOR_MARGIN_HOURS = 1.0;

/** Workload calibration owned by revisions.py — this model's, not the papers'. */
export const WORKLOAD = Object.freeze({
  "points": {
    "Weather": 20,
    "MEL / swap": 15,
    "ATC delays": 15,
    "Extended duty": 15,
    "Sort delay": 10,
    "Reduced rest": 10,
    "Hotel disruption": 10,
    "Long commute": 10
  },
  "default_points": 10,
  "delay_points_per_30_min": 5,
  "delay_points_cap": 20,
  "max_points": 80
});

/** IATA -> [IANA timezone, ISO country]. The port must not hardcode offsets. */
export const STATIONS = Object.freeze({
  "ABE": [
    "America/New_York",
    "US"
  ],
  "ABQ": [
    "America/Denver",
    "US"
  ],
  "ALB": [
    "America/New_York",
    "US"
  ],
  "AMA": [
    "America/Chicago",
    "US"
  ],
  "AMS": [
    "Europe/Amsterdam",
    "NL"
  ],
  "ANC": [
    "America/Anchorage",
    "US"
  ],
  "ATL": [
    "America/New_York",
    "US"
  ],
  "AUS": [
    "America/Chicago",
    "US"
  ],
  "AVL": [
    "America/New_York",
    "US"
  ],
  "AVP": [
    "America/New_York",
    "US"
  ],
  "BAH": [
    "Asia/Bahrain",
    "BH"
  ],
  "BDL": [
    "America/New_York",
    "US"
  ],
  "BFI": [
    "America/Los_Angeles",
    "US"
  ],
  "BGR": [
    "America/New_York",
    "US"
  ],
  "BHM": [
    "America/Chicago",
    "US"
  ],
  "BIL": [
    "America/Denver",
    "US"
  ],
  "BKK": [
    "Asia/Bangkok",
    "TH"
  ],
  "BLI": [
    "America/Los_Angeles",
    "US"
  ],
  "BLR": [
    "Asia/Kolkata",
    "IN"
  ],
  "BNA": [
    "America/Chicago",
    "US"
  ],
  "BOG": [
    "America/Bogota",
    "CO"
  ],
  "BOI": [
    "America/Boise",
    "US"
  ],
  "BOM": [
    "Asia/Kolkata",
    "IN"
  ],
  "BOS": [
    "America/New_York",
    "US"
  ],
  "BRU": [
    "Europe/Brussels",
    "BE"
  ],
  "BTR": [
    "America/Chicago",
    "US"
  ],
  "BTV": [
    "America/New_York",
    "US"
  ],
  "BUF": [
    "America/New_York",
    "US"
  ],
  "BUR": [
    "America/Los_Angeles",
    "US"
  ],
  "BWI": [
    "America/New_York",
    "US"
  ],
  "BZN": [
    "America/Denver",
    "US"
  ],
  "CAE": [
    "America/New_York",
    "US"
  ],
  "CAK": [
    "America/New_York",
    "US"
  ],
  "CAN": [
    "Asia/Shanghai",
    "CN"
  ],
  "CDG": [
    "Europe/Paris",
    "FR"
  ],
  "CGN": [
    "Europe/Berlin",
    "DE"
  ],
  "CHA": [
    "America/New_York",
    "US"
  ],
  "CHS": [
    "America/New_York",
    "US"
  ],
  "CID": [
    "America/Chicago",
    "US"
  ],
  "CLE": [
    "America/New_York",
    "US"
  ],
  "CLT": [
    "America/New_York",
    "US"
  ],
  "CMH": [
    "America/New_York",
    "US"
  ],
  "COS": [
    "America/Denver",
    "US"
  ],
  "CPR": [
    "America/Denver",
    "US"
  ],
  "CRP": [
    "America/Chicago",
    "US"
  ],
  "CRW": [
    "America/New_York",
    "US"
  ],
  "CVG": [
    "America/New_York",
    "US"
  ],
  "CYS": [
    "America/Denver",
    "US"
  ],
  "DAB": [
    "America/New_York",
    "US"
  ],
  "DAL": [
    "America/Chicago",
    "US"
  ],
  "DAY": [
    "America/New_York",
    "US"
  ],
  "DEL": [
    "Asia/Kolkata",
    "IN"
  ],
  "DEN": [
    "America/Denver",
    "US"
  ],
  "DFW": [
    "America/Chicago",
    "US"
  ],
  "DLH": [
    "America/Chicago",
    "US"
  ],
  "DSM": [
    "America/Chicago",
    "US"
  ],
  "DTW": [
    "America/Detroit",
    "US"
  ],
  "DWC": [
    "Asia/Dubai",
    "AE"
  ],
  "DXB": [
    "Asia/Dubai",
    "AE"
  ],
  "ELP": [
    "America/Denver",
    "US"
  ],
  "EMA": [
    "Europe/London",
    "GB"
  ],
  "ERI": [
    "America/New_York",
    "US"
  ],
  "EUG": [
    "America/Los_Angeles",
    "US"
  ],
  "EVV": [
    "America/Chicago",
    "US"
  ],
  "EWR": [
    "America/New_York",
    "US"
  ],
  "FAI": [
    "America/Anchorage",
    "US"
  ],
  "FAR": [
    "America/Chicago",
    "US"
  ],
  "FAT": [
    "America/Los_Angeles",
    "US"
  ],
  "FLL": [
    "America/New_York",
    "US"
  ],
  "FNT": [
    "America/Detroit",
    "US"
  ],
  "FRA": [
    "Europe/Berlin",
    "DE"
  ],
  "FSD": [
    "America/Chicago",
    "US"
  ],
  "FWA": [
    "America/Indiana/Indianapolis",
    "US"
  ],
  "GDL": [
    "America/Mexico_City",
    "MX"
  ],
  "GEG": [
    "America/Los_Angeles",
    "US"
  ],
  "GJT": [
    "America/Denver",
    "US"
  ],
  "GNV": [
    "America/New_York",
    "US"
  ],
  "GPT": [
    "America/Chicago",
    "US"
  ],
  "GRB": [
    "America/Chicago",
    "US"
  ],
  "GRR": [
    "America/Detroit",
    "US"
  ],
  "GRU": [
    "America/Sao_Paulo",
    "BR"
  ],
  "GSO": [
    "America/New_York",
    "US"
  ],
  "GSP": [
    "America/New_York",
    "US"
  ],
  "GTF": [
    "America/Denver",
    "US"
  ],
  "GUM": [
    "Pacific/Guam",
    "US"
  ],
  "HKG": [
    "Asia/Hong_Kong",
    "HK"
  ],
  "HNL": [
    "Pacific/Honolulu",
    "US"
  ],
  "HOU": [
    "America/Chicago",
    "US"
  ],
  "HPN": [
    "America/New_York",
    "US"
  ],
  "HRL": [
    "America/Chicago",
    "US"
  ],
  "HSV": [
    "America/Chicago",
    "US"
  ],
  "IAD": [
    "America/New_York",
    "US"
  ],
  "IAH": [
    "America/Chicago",
    "US"
  ],
  "ICN": [
    "Asia/Seoul",
    "KR"
  ],
  "ICT": [
    "America/Chicago",
    "US"
  ],
  "IDA": [
    "America/Boise",
    "US"
  ],
  "ILM": [
    "America/New_York",
    "US"
  ],
  "IND": [
    "America/Indiana/Indianapolis",
    "US"
  ],
  "ISP": [
    "America/New_York",
    "US"
  ],
  "IST": [
    "Europe/Istanbul",
    "TR"
  ],
  "ITO": [
    "Pacific/Honolulu",
    "US"
  ],
  "JAN": [
    "America/Chicago",
    "US"
  ],
  "JAX": [
    "America/New_York",
    "US"
  ],
  "JFK": [
    "America/New_York",
    "US"
  ],
  "KIX": [
    "Asia/Tokyo",
    "JP"
  ],
  "KOA": [
    "Pacific/Honolulu",
    "US"
  ],
  "LAN": [
    "America/Detroit",
    "US"
  ],
  "LAS": [
    "America/Los_Angeles",
    "US"
  ],
  "LAX": [
    "America/Los_Angeles",
    "US"
  ],
  "LBB": [
    "America/Chicago",
    "US"
  ],
  "LEX": [
    "America/New_York",
    "US"
  ],
  "LGA": [
    "America/New_York",
    "US"
  ],
  "LGB": [
    "America/Los_Angeles",
    "US"
  ],
  "LHR": [
    "Europe/London",
    "GB"
  ],
  "LIH": [
    "Pacific/Honolulu",
    "US"
  ],
  "LIM": [
    "America/Lima",
    "PE"
  ],
  "LIT": [
    "America/Chicago",
    "US"
  ],
  "LNK": [
    "America/Chicago",
    "US"
  ],
  "MAD": [
    "Europe/Madrid",
    "ES"
  ],
  "MAF": [
    "America/Chicago",
    "US"
  ],
  "MCI": [
    "America/Chicago",
    "US"
  ],
  "MCO": [
    "America/New_York",
    "US"
  ],
  "MDT": [
    "America/New_York",
    "US"
  ],
  "MDW": [
    "America/Chicago",
    "US"
  ],
  "MEM": [
    "America/Chicago",
    "US"
  ],
  "MEX": [
    "America/Mexico_City",
    "MX"
  ],
  "MFE": [
    "America/Chicago",
    "US"
  ],
  "MFR": [
    "America/Los_Angeles",
    "US"
  ],
  "MHT": [
    "America/New_York",
    "US"
  ],
  "MIA": [
    "America/New_York",
    "US"
  ],
  "MKE": [
    "America/Chicago",
    "US"
  ],
  "MLB": [
    "America/New_York",
    "US"
  ],
  "MLI": [
    "America/Chicago",
    "US"
  ],
  "MOB": [
    "America/Chicago",
    "US"
  ],
  "MSN": [
    "America/Chicago",
    "US"
  ],
  "MSO": [
    "America/Denver",
    "US"
  ],
  "MSP": [
    "America/Chicago",
    "US"
  ],
  "MSY": [
    "America/Chicago",
    "US"
  ],
  "MUC": [
    "Europe/Berlin",
    "DE"
  ],
  "MXP": [
    "Europe/Rome",
    "IT"
  ],
  "MYR": [
    "America/New_York",
    "US"
  ],
  "NLU": [
    "America/Mexico_City",
    "MX"
  ],
  "NRT": [
    "Asia/Tokyo",
    "JP"
  ],
  "OAK": [
    "America/Los_Angeles",
    "US"
  ],
  "OGG": [
    "Pacific/Honolulu",
    "US"
  ],
  "OKC": [
    "America/Chicago",
    "US"
  ],
  "OMA": [
    "America/Chicago",
    "US"
  ],
  "ONT": [
    "America/Los_Angeles",
    "US"
  ],
  "ORD": [
    "America/Chicago",
    "US"
  ],
  "ORF": [
    "America/New_York",
    "US"
  ],
  "ORH": [
    "America/New_York",
    "US"
  ],
  "PAH": [
    "America/Chicago",
    "US"
  ],
  "PBI": [
    "America/New_York",
    "US"
  ],
  "PDX": [
    "America/Los_Angeles",
    "US"
  ],
  "PEK": [
    "Asia/Shanghai",
    "CN"
  ],
  "PHL": [
    "America/New_York",
    "US"
  ],
  "PHX": [
    "America/Phoenix",
    "US"
  ],
  "PIA": [
    "America/Chicago",
    "US"
  ],
  "PIT": [
    "America/New_York",
    "US"
  ],
  "PSC": [
    "America/Los_Angeles",
    "US"
  ],
  "PSP": [
    "America/Los_Angeles",
    "US"
  ],
  "PTY": [
    "America/Panama",
    "PA"
  ],
  "PVD": [
    "America/New_York",
    "US"
  ],
  "PVG": [
    "Asia/Shanghai",
    "CN"
  ],
  "PWM": [
    "America/New_York",
    "US"
  ],
  "RAP": [
    "America/Denver",
    "US"
  ],
  "RDM": [
    "America/Los_Angeles",
    "US"
  ],
  "RDU": [
    "America/New_York",
    "US"
  ],
  "RFD": [
    "America/Chicago",
    "US"
  ],
  "RIC": [
    "America/New_York",
    "US"
  ],
  "RNO": [
    "America/Los_Angeles",
    "US"
  ],
  "ROA": [
    "America/New_York",
    "US"
  ],
  "ROC": [
    "America/New_York",
    "US"
  ],
  "RSW": [
    "America/New_York",
    "US"
  ],
  "SAN": [
    "America/Los_Angeles",
    "US"
  ],
  "SAT": [
    "America/Chicago",
    "US"
  ],
  "SAV": [
    "America/New_York",
    "US"
  ],
  "SBA": [
    "America/Los_Angeles",
    "US"
  ],
  "SBN": [
    "America/Indiana/Indianapolis",
    "US"
  ],
  "SCL": [
    "America/Santiago",
    "CL"
  ],
  "SDF": [
    "America/Kentucky/Louisville",
    "US"
  ],
  "SDF2": [
    "America/Kentucky/Louisville",
    "US"
  ],
  "SEA": [
    "America/Los_Angeles",
    "US"
  ],
  "SFO": [
    "America/Los_Angeles",
    "US"
  ],
  "SGF": [
    "America/Chicago",
    "US"
  ],
  "SHA": [
    "Asia/Shanghai",
    "CN"
  ],
  "SHV": [
    "America/Chicago",
    "US"
  ],
  "SIN": [
    "Asia/Singapore",
    "SG"
  ],
  "SJC": [
    "America/Los_Angeles",
    "US"
  ],
  "SJU": [
    "America/Puerto_Rico",
    "US"
  ],
  "SLC": [
    "America/Denver",
    "US"
  ],
  "SMF": [
    "America/Los_Angeles",
    "US"
  ],
  "SNA": [
    "America/Los_Angeles",
    "US"
  ],
  "SRQ": [
    "America/New_York",
    "US"
  ],
  "STL": [
    "America/Chicago",
    "US"
  ],
  "STN": [
    "Europe/London",
    "GB"
  ],
  "SYD": [
    "Australia/Sydney",
    "AU"
  ],
  "SYR": [
    "America/New_York",
    "US"
  ],
  "SZX": [
    "Asia/Shanghai",
    "CN"
  ],
  "TLH": [
    "America/New_York",
    "US"
  ],
  "TOL": [
    "America/New_York",
    "US"
  ],
  "TPA": [
    "America/New_York",
    "US"
  ],
  "TPE": [
    "Asia/Taipei",
    "TW"
  ],
  "TRI": [
    "America/New_York",
    "US"
  ],
  "TUL": [
    "America/Chicago",
    "US"
  ],
  "TUS": [
    "America/Phoenix",
    "US"
  ],
  "TWF": [
    "America/Boise",
    "US"
  ],
  "TYS": [
    "America/New_York",
    "US"
  ],
  "VCP": [
    "America/Sao_Paulo",
    "BR"
  ],
  "WAW": [
    "Europe/Warsaw",
    "PL"
  ],
  "XNA": [
    "America/Chicago",
    "US"
  ],
  "YHM": [
    "America/Toronto",
    "CA"
  ],
  "YVR": [
    "America/Vancouver",
    "CA"
  ],
  "YYZ": [
    "America/Toronto",
    "CA"
  ]
});

export const DOMESTIC_COUNTRIES = Object.freeze([
  "US"
]);
