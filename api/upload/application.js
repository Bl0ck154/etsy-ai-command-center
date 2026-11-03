import { uploadImageAction } from './image-transfer.js';

export function createUploadApplication({
  etsyBase,
  apiKey,
  shopId,
  fetchImpl = fetch,
  uploadImageActionImpl = uploadImageAction,
} = {}) {
  async function deleteImage(input, { token }) {
    const response = await fetchImpl(
      `${etsyBase}/shops/${shopId}/listings/${input.listing_id}/images/${input.listing_image_id}`,
      {
        method: 'DELETE',
        headers: { 'x-api-key': apiKey, 'Authorization': `Bearer ${token}` },
      },
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error_description || `Delete failed: ${response.status}`);
    }
    return { success: true };
  }

  async function uploadImage(input, { token }) {
    return uploadImageActionImpl(input, { token, shopId });
  }

  async function getImages(input, { token }) {
    if (!input.listing_id) {
      const error = new Error('listing_id required');
      error.status = 400;
      throw error;
    }
    const response = await fetchImpl(
      `${etsyBase}/listings/${input.listing_id}/images`,
      { headers: { 'x-api-key': apiKey, 'Authorization': `Bearer ${token}` } },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error_description || `Get images failed: ${response.status}`);
    return data;
  }

  async function execute(input, context) {
    if (input.action === 'deleteImage') return { kind: 'delete', data: await deleteImage(input, context) };
    if (input.action === 'uploadImage' || input.action === 'uploadImageFromUrl') {
      return { kind: 'upload', data: await uploadImage(input, context) };
    }
    if (input.action === 'getImages') return { kind: 'get', data: await getImages(input, context) };
    const error = new Error(`Unknown action: ${input.action}`);
    error.status = 400;
    throw error;
  }

  return { deleteImage, uploadImage, getImages, execute };
}
