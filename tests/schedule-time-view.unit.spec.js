import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  DEFAULT_AUDIENCE_TIME_ZONE,
  OWNER_DISPLAY_TIME_ZONE,
  dualScheduleDateLabel,
  dualScheduleTimeLabel,
  formatScheduleDateInZone,
  scheduleAudienceTimeZone,
  scheduleDayKey,
  scheduleTimeDetails,
  scheduleZoneLabel,
} from '../public/utils/schedule/time.js';
import { scheduleTimePanelMarkup } from '../public/utils/schedule/time-panel.js';

test('schedule timezone defaults and metadata precedence remain stable', () => {
  expect(DEFAULT_AUDIENCE_TIME_ZONE).toBe('America/New_York');
  expect(OWNER_DISPLAY_TIME_ZONE).toBe('Europe/Kyiv');
  expect(scheduleAudienceTimeZone({})).toBe('America/New_York');
  expect(scheduleAudienceTimeZone({ metadata: { scheduled_timezone: 'America/Chicago' } })).toBe('America/Chicago');
  expect(scheduleAudienceTimeZone({ scheduled_timezone: 'America/Denver', metadata: { scheduled_timezone: 'America/Chicago' } })).toBe('America/Denver');
});

test('zone labels preserve US and Kyiv names and unknown passthrough', () => {
  expect(scheduleZoneLabel('America/New_York')).toBe('US Eastern');
  expect(scheduleZoneLabel('America/Los_Angeles')).toBe('US Pacific');
  expect(scheduleZoneLabel('Europe/Kyiv')).toBe('Kyiv');
  expect(scheduleZoneLabel('Europe/Vilnius')).toBe('Europe/Vilnius');
});

test('time details project owner and audience zones independently', () => {
  const value = '2026-08-14T18:00:00Z';
  const details = scheduleTimeDetails(value, { scheduled_timezone: 'America/New_York' }, { timeFormat: '24' });
  expect(details.audienceLabel).toBe('US Eastern');
  expect(details.ownerTime).toBeTruthy();
  expect(details.audienceTime).toBeTruthy();
  expect(details.ownerDate).toBeTruthy();
  expect(details.audienceDate).toBeTruthy();
  expect(details.ownerTime).not.toBe(details.audienceTime);
});

test('formatting remains fail-soft and null-safe', () => {
  expect(formatScheduleDateInZone(null, 'Europe/Kyiv')).toBeNull();
  expect(formatScheduleDateInZone('not-a-date', 'Invalid/Zone')).toBe('not-a-date');
  expect(dualScheduleDateLabel(null)).toBeNull();
  expect(dualScheduleTimeLabel(null)).toBe('Draft');
});

test('day key preserves local calendar components', () => {
  expect(scheduleDayKey(new Date(2026, 7, 4, 23, 30))).toBe('2026-08-04');
});

test('time panel markup escapes label and includes owner/audience presentation', () => {
  const markup = scheduleTimePanelMarkup('2026-08-14T18:00:00Z', { scheduled_timezone: 'America/Chicago' }, '<Scheduled>', {
    timeFormat: '24',
  });
  expect(markup).toContain('&lt;Scheduled&gt; · Kyiv');
  expect(markup).toContain('US audience · US Central');
  expect(markup).toContain('sched-time-primary-value');
});

test('schedule-view-model remains a compatibility facade', () => {
  const source = fs.readFileSync(new URL('../public/utils/schedule-view-model.js', import.meta.url), 'utf8');
  expect(source.split('\n').length).toBeLessThan(18);
  expect(source).not.toContain('Intl.DateTimeFormat');
  expect(source).not.toContain('sched-time-panel');
  expect(source).toContain("from './schedule/time.js'");
  expect(source).toContain("from './schedule/time-panel.js'");
});
