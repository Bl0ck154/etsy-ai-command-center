// Validation and request helpers for Etsy listing-image alt text.
// Etsy's current OpenAPI schema accepts alt_text on uploadListingImage (POST multipart)
// and returns it from getListingImage(s). This application intentionally enforces the
// stricter product requirement of 250 characters (Etsy's schema currently says 500).

export const LISTING_IMAGE_ALT_TEXT_MAX_LENGTH = 250;

function validationError(message, code) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  error.isValidation = true;
  return error;
}

export function normalizeListingImageAltText(value) {
  if (typeof value !== 'string') {
    throw validationError('alt_text must be a string', 'ALT_TEXT_TYPE');
  }
  return value.replace(/\s+/g, ' ').trim();
}

export function validateListingImageAltText(value) {
  const altText = normalizeListingImageAltText(value);
  if (!altText) {
    throw validationError('alt_text is required and must describe the image', 'ALT_TEXT_REQUIRED');
  }
  if (Array.from(altText).length > LISTING_IMAGE_ALT_TEXT_MAX_LENGTH) {
    throw validationError(`alt_text must be ${LISTING_IMAGE_ALT_TEXT_MAX_LENGTH} characters or fewer`, 'ALT_TEXT_TOO_LONG');
  }
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(altText) || /^[^\s]+\.(?:avif|gif|jpe?g|png|webp)$/i.test(altText)) {
    throw validationError('alt_text must describe the image, not contain only a URL or file name', 'ALT_TEXT_NOT_DESCRIPTIVE');
  }
  const words = altText.match(/[\p{L}\p{N}]+/gu) || [];
  if (altText.length < 10 || words.length < 2) {
    throw validationError('alt_text must be a descriptive phrase of at least two words', 'ALT_TEXT_NOT_DESCRIPTIVE');
  }
  return altText;
}

export function requireExplicitListingWriteConfirmation(params = {}) {
  if (params.confirmed !== true) {
    const error = validationError('Explicit admin/user confirmation is required before changing an existing Etsy listing', 'CONFIRMATION_REQUIRED');
    error.status = 409;
    throw error;
  }
  const confirmedBy = String(params.confirmed_by || '').trim().toLowerCase();
  if (confirmedBy !== 'admin' && confirmedBy !== 'user') {
    throw validationError('confirmed_by must be "admin" or "user"', 'CONFIRMATION_ACTOR_REQUIRED');
  }
  return confirmedBy;
}

export function listingImagePath(listingId, listingImageId = null, shopId = null) {
  const listing = positiveId(listingId, 'listing_id');
  if (shopId != null) {
    const shop = positiveId(shopId, 'shop_id');
    return `/shops/${shop}/listings/${listing}/images`;
  }
  const suffix = listingImageId == null ? '' : `/${positiveId(listingImageId, 'listing_image_id')}`;
  return `/listings/${listing}/images${suffix}`;
}

function positiveId(value, name) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || BigInt(text) < 1n) throw validationError(`${name} must be a positive integer`, 'INVALID_ID');
  return text;
}

export function normalizeListingImagesResponse(response) {
  const images = Array.isArray(response?.results) ? response.results : [];
  return images.map(image => ({
    ...image,
    alt_text: typeof image.alt_text === 'string' ? image.alt_text : '',
  }));
}
