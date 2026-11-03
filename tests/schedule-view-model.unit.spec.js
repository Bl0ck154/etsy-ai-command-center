import fs from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  dualScheduleDateLabel,
  dualScheduleTimeLabel,
  formatScheduleDateInZone,
  scheduleAudienceTimeZone,
  scheduleDayKey,
  scheduleTimeDetails,
  scheduleTimePanelMarkup,
  scheduleZoneLabel,
} from '../public/utils/schedule-view-model.js';

const SUMMER_INSTANT = '2026-08-09T14:30:00.000Z';

test('audience timezone presentation preserves record, metadata, and default precedence', () => {
  expect(scheduleAudienceTimeZone({
    scheduled_timezone: 'America/Chicago',
    metadata: { scheduled_timezone: 'America/Denver' },
  })).toBe('America/Chicago');
  expect(scheduleAudienceTimeZone({
    metadata: { scheduled_timezone: 'America/Denver' },
  })).toBe('America/Denver');
  expect(scheduleAudienceTimeZone({})).toBe('America/New_York');

  expect(scheduleZoneLabel('America/New_York')).toBe('US Eastern');
  expect(scheduleZoneLabel('America/Los_Angeles')).toBe('US Pacific');
  expect(scheduleZoneLabel('Pacific/Auckland')).toBe('Pacific/Auckland');
});

test('schedule details show one instant in owner and audience zones', () => {
  expect(scheduleTimeDetails(SUMMER_INSTANT, {})).toEqual({
    ownerTime: '17:30',
    ownerDate: '9 Aug 2026',
    audienceTime: '10:30 AM',
    audienceDate: 'Aug 9, 2026',
    audienceLabel: 'US Eastern',
  });
  expect(scheduleTimeDetails(SUMMER_INSTANT, {}, { timeFormat: '24' }))
    .toMatchObject({ ownerTime: '17:30', audienceTime: '10:30' });
  expect(scheduleTimeDetails(null, {})).toBeNull();
});

test('dual schedule labels preserve date, timezone labels, and time-format choice', () => {
  expect(dualScheduleDateLabel(SUMMER_INSTANT, {}))
    .toBe('Aug 9, 2026, 10:30 AM US Eastern · 9 Aug 2026, 17:30 Kyiv');
  expect(dualScheduleTimeLabel(SUMMER_INSTANT, {}))
    .toBe('10:30 AM US Eastern · 17:30 Kyiv');
  expect(dualScheduleTimeLabel(
    SUMMER_INSTANT,
    { scheduled_timezone: 'America/Los_Angeles' },
    { timeFormat: '24' },
  )).toBe('07:30 US Pacific · 17:30 Kyiv');
  expect(dualScheduleTimeLabel(null, {})).toBe('Draft');
});

test('zoned formatter fails closed to the supplied value for invalid input', () => {
  expect(formatScheduleDateInZone(null, 'Europe/Kyiv')).toBeNull();
  expect(formatScheduleDateInZone('not-a-date', 'Europe/Kyiv')).toBe('not-a-date');
  expect(formatScheduleDateInZone(SUMMER_INSTANT, 'Not/AZone')).toBe(SUMMER_INSTANT);
});

test('time panel markup renders the existing dual-zone UI and escapes its label', () => {
  const markup = scheduleTimePanelMarkup(
    SUMMER_INSTANT,
    { scheduled_timezone: 'America/New_York' },
    '<Due>',
    { timeFormat: '24' },
  );

  expect(markup).toContain('aria-label="&lt;Due&gt; time"');
  expect(markup).toContain('&lt;Due&gt; · Kyiv');
  expect(markup).toContain('17:30');
  expect(markup).toContain('US audience · US Eastern');
  expect(markup).toContain('10:30');
  expect(scheduleTimePanelMarkup(null)).toBe('');
});

test('day keys use the existing local calendar representation', () => {
  expect(scheduleDayKey(new Date(2026, 0, 2, 23, 59))).toBe('2026-01-02');
  expect(scheduleDayKey(new Date(2026, 10, 12, 0, 1))).toBe('2026-11-12');
});

test('Schedule page delegates date presentation without moving queue or media ownership', async () => {
  const pageSource = await fs.readFile(new URL('../public/pages/schedule.js', import.meta.url), 'utf8');
  const viewModelSource = await fs.readFile(
    new URL('../public/utils/schedule-view-model.js', import.meta.url),
    'utf8',
  );

  expect(pageSource).toContain("from '../utils/schedule-view-model.js'");
  for (const functionName of [
    'scheduleAudienceTimeZone',
    'scheduleZoneLabel',
    'scheduleTimeDetails',
    'scheduleDayKey',
  ]) {
    expect(pageSource).not.toContain(`function ${functionName}(`);
  }
  expect(viewModelSource).not.toMatch(/schedule-store|media-url|approved_for_publish|fetch\(|localStorage/i);
});
