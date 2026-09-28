/**
 * whatsnew.js — what changed, and how to use it.
 *
 * Content only. `ui.js` owns the DOM, so this module exports the release notes and the icons and
 * nothing else; nothing here touches the document.
 *
 * Two rules for writing an entry, both learned from the alternative:
 *
 *   1. **Say what to do, not what was built.** "Circadian sleep propensity added to the
 *      integrator" is true and tells a pilot nothing. A release note on a tool is documentation
 *      that happens to arrive at the right moment, so every entry below is written as an
 *      instruction with the change as its reason.
 *   2. **Only announce what a pilot can see or act on.** A bug fix that changes a number belongs
 *      in the git history. It goes here only when they would otherwise be surprised by it.
 *
 * `RELEASE` gates the sheet and is deliberately NOT the asset version: assets bump on every
 * deploy, including pure bug fixes, and a "what's new" that reappears after a typo correction
 * teaches people to dismiss it without reading. Bump this only when the list below changes.
 */

export const RELEASE = "2026.09.28";

/** 24×24 stroke paths; the global `svg` rule in ui.css supplies fill/stroke/linecap. */
export const ICONS = {
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  carry: '<path d="M3 17l5-5 4 4 7-8"/><path d="M15 8h4v4"/><path d="M3 21h18"/>',
  commute: '<path d="M5 17h14"/><path d="M6 17v2"/><path d="M18 17v2"/>'
    + '<path d="M4 17l1.6-5.2A2 2 0 0 1 7.5 10.4h9a2 2 0 0 1 1.9 1.4L20 17"/>'
    + '<path d="M7 13.8h10"/>',
  workload: '<path d="M14.7 6.3a4 4 0 0 0 5 5L15 16l-3.5 3.5a2.1 2.1 0 0 1-3-3L12 13Z"/>'
    + '<path d="M9 9 4.5 4.5"/><path d="M7 3 3 7"/>',
  report: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/>'
    + '<path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>',
};

/**
 * The current release. `em` is for the words a pilot would type, not for emphasis.
 */
export const NOTES = [
  {
    icon: "moon",
    title: "Tell it how you slept",
    body: "Three fields sit above <em>Analyze trip</em>, one per night before the trip. Say it the "
        + "way you'd say it out loud — <em>about 5 hours</em>, <em>bad</em>, <em>2300 to 0600</em>, "
        + "<em>7 hours but broken</em>. The line underneath shows exactly what it understood, or "
        + "tells you it couldn't read it and assumed a normal night.",
  },
  {
    icon: "carry",
    title: "Fatigue now carries between trips",
    body: "Every pairing used to be scored as though you turned up rested, whatever you had just "
        + "flown. Report those nights and the debt is carried into duty day 1 — which is where a "
        + "four-day trip starting the morning after a four-day trip stops looking the same as one "
        + "starting after a week off.",
  },
  {
    icon: "commute",
    title: "The commute costs sleep, not just effort",
    body: "Travelling overnight to base is no longer counted only as extra workload. It is a night "
        + "that did not happen, and the hours come off the night before day 1.",
  },
  {
    icon: "workload",
    title: "More of what actually made the day hard",
    body: "APU inop, heat or cold, de-ice, turbulence, a diversion or go-around. Logging these "
        + "raises the workload figure without touching the physiology — sleep is sleep, and the "
        + "report stays clear about which is which.",
  },
  {
    icon: "report",
    title: "The assessment opens itself",
    body: "When an analysis finishes, the safety assessment comes up to be read. Downloading it is "
        + "a choice; seeing it is not.",
  },
];

export const FIRST_RUN_BLURB =
  "It reads a Trip Board, models the sleep the schedule actually allows, and shows you where your "
  + "effectiveness bottoms out. Here is what it does and how to drive it.";

export const UPDATE_BLURB =
  "A few things changed in how this reads your trip. Thirty seconds and you will know what moved.";
