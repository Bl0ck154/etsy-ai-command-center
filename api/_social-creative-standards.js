export const SOCIAL_CREATIVE_ADVERTISING_STANDARD = [
  'Treat every selected frame as advertising, not merely an attractive illustration.',
  'For a transformation offer, the lead must make the input-to-result relationship immediately understandable at feed size through one AI-chosen campaign-specific device: for example spatial source-to-result flow, directional movement, a before/result reveal, concise hook copy, an annotated transformation, or another coherent visual relationship.',
  'Do not mechanically require arrows or text, but do not prohibit every connector, label, or hook by default. An emotional finished illustration with tiny disconnected source portraits is not automatically clear advertising.',
  'For a synthetic or fictional demonstration, put the disclosure in the platform caption. Do not spend on-image copy on formal asset labels such as “illustrative example”, “honestly labeled”, or “illustrative animation sequence”; if on-image words improve the ad, use a concise buyer-facing hook or explain the offer naturally instead.',
].join(' ');

export const SOCIAL_CREATIVE_EDGE_SAFETY_STANDARD = [
  'Treat every evidence-bearing inset photo, vignette, comparison panel, device, product, source, or finished result as a complete visual object.',
  'Its full relevant boundary and relationship must remain visibly inside the final canvas with an intentional safe margin.',
  'Canvas-edge clipping is a blocking composition defect when it makes a proof element look accidental, incomplete, or harder to understand.',
  'An intentional full-bleed crop is acceptable only when the cropped object is not serving as a discrete source/result proof element and no indispensable evidence is lost.',
].join(' ');

export const SOCIAL_CREATIVE_SEQUENCE_STANDARD = [
  'Choose frame count from distinct buyer-facing communication jobs, not from a carousel minimum or a familiar repeated count.',
  'Different scenery, pose, crop, or styling does not create progression when two frames communicate the same proof in the same way.',
  'Compare every unique campaign asset pair across all platforms, not only frames inside one platform variant. Separate generated files are near-duplicates when they repeat the same subject, evidence relationship, visual progression, and hook while changing only aspect ratio, crop, framing, decoration, or layout.',
  'A platform adaptation must either reuse one genuinely compatible shared asset or earn a separate asset with a materially different platform-native buyer job, visual idea, discovery angle, proof detail, or narrative beat. Do not generate a second near-copy merely to fill another aspect ratio.',
  'Every additional frame must answer a different useful buyer question, add materially different evidence, deepen trust, or create a deliberate reveal; otherwise remove it.',
  'When recent campaigns repeat the same count, explicitly consider a different native structure, but never add filler only for variety.',
].join(' ');

export const SOCIAL_CREATIVE_SHARED_STANDARDS = [
  SOCIAL_CREATIVE_ADVERTISING_STANDARD,
  SOCIAL_CREATIVE_EDGE_SAFETY_STANDARD,
  SOCIAL_CREATIVE_SEQUENCE_STANDARD,
];
