export const DEFAULT_AUDIENCE_TIME_ZONE = 'America/New_York';
export const OWNER_DISPLAY_TIME_ZONE = 'Europe/Kyiv';

export function scheduleAudienceTimeZone(post = {}) {
  return String(
    post.scheduled_timezone
      || post.metadata?.scheduled_timezone
      || DEFAULT_AUDIENCE_TIME_ZONE,
  );
}

export function scheduleZoneLabel(timeZone) {
  const labels = {
    'America/New_York': 'US Eastern',
    'America/Chicago': 'US Central',
    'America/Denver': 'US Mountain',
    'America/Los_Angeles': 'US Pacific',
    'Europe/Kyiv': 'Kyiv',
  };
  return labels[timeZone] || timeZone;
}

export function scheduleTimeOptions(timeFormat, force24 = false) {
  return force24 || timeFormat === '24'
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { hour: 'numeric', minute: '2-digit' };
}

export function formatScheduleDateInZone(val, timeZone, {
  includeDate = true,
  force24 = false,
  locale = 'en-US',
  timeFormat = '12',
} = {}) {
  if (!val) return null;
  try {
    const dateOpts = includeDate ? { month: 'short', day: 'numeric', year: 'numeric' } : {};
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      ...dateOpts,
      ...scheduleTimeOptions(timeFormat, force24),
    }).format(new Date(val));
  } catch {
    return String(val);
  }
}

export function formatScheduleDateOnlyInZone(val, timeZone, locale = 'en-US') {
  if (!val) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(val));
  } catch {
    return String(val);
  }
}

export function scheduleTimeDetails(val, post = {}, { timeFormat = '12' } = {}) {
  if (!val) return null;
  const audienceZone = scheduleAudienceTimeZone(post);
  return {
    ownerTime: formatScheduleDateInZone(val, OWNER_DISPLAY_TIME_ZONE, {
      includeDate: false,
      force24: true,
      locale: 'en-GB',
      timeFormat,
    }),
    ownerDate: formatScheduleDateOnlyInZone(val, OWNER_DISPLAY_TIME_ZONE, 'en-GB'),
    audienceTime: formatScheduleDateInZone(val, audienceZone, {
      includeDate: false,
      timeFormat,
    }),
    audienceDate: formatScheduleDateOnlyInZone(val, audienceZone),
    audienceLabel: scheduleZoneLabel(audienceZone),
  };
}

function formatLocalScheduleDate(val, timeFormat) {
  if (!val) return null;
  try {
    return new Date(val).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      ...scheduleTimeOptions(timeFormat),
    });
  } catch {
    return String(val);
  }
}

function formatLocalScheduleTime(val, timeFormat) {
  if (!val) return 'Draft';
  return new Date(val).toLocaleTimeString('en-US', scheduleTimeOptions(timeFormat));
}

export function dualScheduleDateLabel(val, post = {}, { timeFormat = '12' } = {}) {
  if (!val) return null;
  const audienceZone = scheduleAudienceTimeZone(post);
  const audience = formatScheduleDateInZone(val, audienceZone, { timeFormat });
  const owner = formatScheduleDateInZone(val, OWNER_DISPLAY_TIME_ZONE, {
    force24: true,
    locale: 'en-GB',
    timeFormat,
  });
  if (!audience || !owner) return formatLocalScheduleDate(val, timeFormat);
  return `${audience} ${scheduleZoneLabel(audienceZone)} · ${owner} Kyiv`;
}

export function dualScheduleTimeLabel(val, post = {}, { timeFormat = '12' } = {}) {
  if (!val) return 'Draft';
  const audienceZone = scheduleAudienceTimeZone(post);
  const audience = formatScheduleDateInZone(val, audienceZone, {
    includeDate: false,
    timeFormat,
  });
  const owner = formatScheduleDateInZone(val, OWNER_DISPLAY_TIME_ZONE, {
    includeDate: false,
    force24: true,
    locale: 'en-GB',
    timeFormat,
  });
  return audience && owner
    ? `${audience} ${scheduleZoneLabel(audienceZone)} · ${owner} Kyiv`
    : formatLocalScheduleTime(val, timeFormat);
}

export function scheduleDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
