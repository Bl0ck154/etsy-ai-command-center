export const PRESETS = {
  etsy: {
    w: 2000,
    h: 2000,
    label: 'Etsy thumbnail',
    ratio: '1:1',
    note: 'Safe for all Etsy page layouts',
  },
  social: {
    w: 1080,
    h: 1350,
    label: 'Instagram / Pinterest',
    ratio: '4:5',
    note: 'Instagram 4:5 feed. Pinterest crops bottom ~13% — keep content high',
  },
  stories: {
    w: 1080,
    h: 1920,
    label: 'Stories & Reels',
    ratio: '9:16',
    note: 'Full-screen vertical. Keep key content in middle 4:5 safe zone',
  },
};

export const CROSS_PLATFORM_SET = ['etsy', 'social', 'stories'];
