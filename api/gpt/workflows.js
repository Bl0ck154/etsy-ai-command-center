import { buildListingBody, buildListingUpdateBody } from '../_listing-body.js';
import { hasVariationInventoryForEtsy } from '../etsy.js';
import {
  associateDigitalListingFile,
  associateListingImage,
  associateListingVideo,
  createDraftListing,
  deleteListing,
  getListing,
  getListingImages,
  getListingVideos,
  listDigitalListingFiles,
  strictPositiveId,
  updateListing,
  updateListingInventory,
  updateListingPersonalization,
  uploadPreparedDigitalListingFile,
  uploadPreparedListingImage,
  uploadPreparedListingVideo,
} from './etsy-service.js';

export const MAX_COMPLETE_DRAFT_IMAGES = 20;
export const MAX_COMPLETE_DRAFT_FILES = 5;
export const MAX_COMPLETE_DRAFT_PREPARED_ASSETS = 26;
export const MAX_BULK_CREATE_ITEMS = 10;
export const MAX_BULK_UPDATE_ITEMS = 25;

const DIFF_FIELDS = [
  'title', 'description', 'price', 'quantity', 'tags', 'materials', 'who_made', 'when_made',
  'taxonomy_id', 'listing_type', 'is_supply', 'should_auto_renew', 'shop_section_id',
  'shipping_profile_id', 'return_policy_id', 'readiness_state_id', 'processing_min',
  'processing_max', 'language',
  'state',
];

function workflowError(message, code = 'WORKFLOW_FAILED', status = 400, result = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (result) error.workflow_result = result;
  return error;
}

function boundedArray(value, name, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw workflowError(`${name} must be an array`, 'INVALID_WORKFLOW_INPUT');
  if (value.length > max) throw workflowError(`${name} supports at most ${max} items`, 'WORKFLOW_LIMIT_EXCEEDED');
  return value;
}

function preparedBuffer(item, name) {
  if (!item || typeof item !== 'object' || !Buffer.isBuffer(item.buffer) || !item.buffer.length) {
    throw workflowError(`${name} must contain a non-empty prepared Buffer`, 'INVALID_PREPARED_FILE');
  }
  if (item.source_url || item.sourceUrl || item.path || item.local_path || item.localPath) {
    throw workflowError(`${name} cannot contain source URLs or local paths`, 'UNSAFE_PREPARED_FILE');
  }
  return item;
}

function preparedTarget(item, name) {
  const explicit = String(item.target || item.purpose || '').trim().toLowerCase();
  if (explicit) {
    const aliases = {
      image: 'listing_image',
      listing_image: 'listing_image',
      video: 'listing_video',
      listing_video: 'listing_video',
      file: 'digital_file',
      digital_file: 'digital_file',
    };
    if (!aliases[explicit]) throw workflowError(`${name}.target is unsupported`, 'INVALID_PREPARED_FILE_TARGET');
    return aliases[explicit];
  }
  const kind = String(item.kind || '').trim().toLowerCase();
  const mime = String(item.mimeType || item.contentType || '').trim().toLowerCase();
  if (kind === 'image' || mime.startsWith('image/')) return 'listing_image';
  if (kind === 'video' || mime.startsWith('video/')) return 'listing_video';
  return 'digital_file';
}

function recordStage(stages, stage, status, extra = {}) {
  const record = { stage, status, ...extra };
  stages.push(record);
  return record;
}

async function rollbackNewDraft(listingId, stages) {
  try {
    await deleteListing({ listingId });
    recordStage(stages, 'rollback_delete_draft', 'succeeded', { listing_id: listingId });
    return { attempted: true, succeeded: true };
  } catch (error) {
    recordStage(stages, 'rollback_delete_draft', 'failed', { listing_id: listingId, error: error.message });
    return { attempted: true, succeeded: false, error: error.message };
  }
}

async function verifyDraft(shopId, listingId) {
  const [listing, images, videos, files] = await Promise.all([
    getListing({ listingId }),
    getListingImages({ listingId }).catch(error => ({ error: error.message, results: [] })),
    getListingVideos({ listingId }).catch(error => ({ error: error.message, results: [] })),
    listDigitalListingFiles({ shopId, listingId }).catch(error => ({ error: error.message, results: [] })),
  ]);
  return {
    listing,
    image_count: images.results?.length || 0,
    video_count: videos.results?.length || 0,
    file_count: files.results?.length || 0,
    warnings: [images.error, videos.error, files.error].filter(Boolean),
  };
}

export async function createCompleteDraft({
  shopId,
  listing,
  inventory,
  personalizationQuestions,
  images: rawImages,
  video: rawVideo,
  preparedFiles: rawFiles,
  atomic = true,
  verify = true,
  uploadPreparedListingImageImpl = uploadPreparedListingImage,
} = {}) {
  const explicitImages = boundedArray(rawImages, 'images', MAX_COMPLETE_DRAFT_IMAGES);
  const preparedAssets = boundedArray(rawFiles, 'preparedFiles', MAX_COMPLETE_DRAFT_PREPARED_ASSETS);
  explicitImages.forEach((image, index) => preparedBuffer(image, `images[${index}]`));
  preparedAssets.forEach((file, index) => preparedBuffer(file, `preparedFiles[${index}]`));
  if (rawVideo) preparedBuffer(rawVideo, 'video');
  const images = [...explicitImages];
  const files = [];
  const videos = rawVideo ? [rawVideo] : [];
  preparedAssets.forEach((asset, index) => {
    const target = preparedTarget(asset, `preparedFiles[${index}]`);
    if (target === 'listing_image') images.push(asset);
    else if (target === 'listing_video') videos.push(asset);
    else files.push(asset);
  });
  if (images.length > MAX_COMPLETE_DRAFT_IMAGES) {
    throw workflowError(`A complete draft supports at most ${MAX_COMPLETE_DRAFT_IMAGES} listing images`, 'WORKFLOW_LIMIT_EXCEEDED');
  }
  if (videos.length > 1) throw workflowError('A complete draft supports at most one listing video', 'WORKFLOW_LIMIT_EXCEEDED');
  if (files.length > MAX_COMPLETE_DRAFT_FILES) {
    throw workflowError(`A complete draft supports at most ${MAX_COMPLETE_DRAFT_FILES} digital files`, 'WORKFLOW_LIMIT_EXCEEDED');
  }
  if (personalizationQuestions !== undefined && !Array.isArray(personalizationQuestions)) {
    throw workflowError('personalizationQuestions must be an array', 'INVALID_WORKFLOW_INPUT');
  }

  const stages = [];
  let listingId = null;
  try {
    const created = await createDraftListing({ shopId, listing });
    listingId = strictPositiveId(created?.listing_id, 'listing_id');
    recordStage(stages, 'create_draft', 'succeeded', { listing_id: listingId });

    if (inventory) {
      await updateListingInventory({ listingId, inventory });
      recordStage(stages, 'inventory', 'succeeded');
    }
    if (personalizationQuestions?.length) {
      await updateListingPersonalization({ shopId, listingId, questions: personalizationQuestions });
      recordStage(stages, 'personalization', 'succeeded');
    }
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const rank = image.rank ?? index + 1;
      const uploaded = await uploadPreparedListingImageImpl({
        shopId,
        listingId,
        buffer: image.buffer,
        mimeType: image.mimeType || image.contentType,
        rank,
        overwrite: image.overwrite,
        altText: image.altText ?? image.alt_text,
      });
      recordStage(stages, 'image', 'succeeded', { rank, listing_image_id: uploaded?.listing_image_id });
    }
    if (videos.length) {
      const video = videos[0];
      const uploaded = await uploadPreparedListingVideo({
        shopId,
        listingId,
        buffer: video.buffer,
        name: video.name,
        mimeType: video.mimeType || video.contentType,
      });
      recordStage(stages, 'video', 'succeeded', { video_id: uploaded?.video_id });
    }
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const rank = file.rank ?? index + 1;
      const uploaded = await uploadPreparedDigitalListingFile({
        shopId,
        listingId,
        buffer: file.buffer,
        name: file.name,
        mimeType: file.mimeType || file.contentType,
        rank,
      });
      recordStage(stages, 'digital_file', 'succeeded', { rank, listing_file_id: uploaded?.listing_file_id });
    }

    let verification = null;
    if (verify) {
      try {
        verification = await verifyDraft(shopId, listingId);
        recordStage(stages, 'verify', 'succeeded', {
          image_count: verification.image_count,
          video_count: verification.video_count,
          file_count: verification.file_count,
        });
      } catch (error) {
        recordStage(stages, 'verify', 'warning', { error: error.message });
      }
    }
    return { success: true, listing_id: listingId, state: 'draft', stages, verification };
  } catch (error) {
    recordStage(stages, 'workflow', 'failed', { error: error.message });
    const rollback = listingId && atomic ? await rollbackNewDraft(listingId, stages) : { attempted: false, succeeded: false };
    const result = { success: false, listing_id: listingId, state: 'draft', stages, rollback };
    throw workflowError(
      rollback.succeeded ? `Complete draft failed and was rolled back: ${error.message}` : `Complete draft failed: ${error.message}`,
      rollback.succeeded ? 'COMPLETE_DRAFT_ROLLED_BACK' : 'COMPLETE_DRAFT_PARTIAL_FAILURE',
      error.status || 502,
      result,
    );
  }
}

function listingCopy(source, changes = {}) {
  const base = {
    title: source.title,
    description: source.description,
    price: source.price,
    quantity: source.quantity,
    tags: source.tags,
    materials: source.materials,
    who_made: source.who_made,
    when_made: source.when_made,
    taxonomy_id: source.taxonomy_id,
    listing_type: source.listing_type,
    is_supply: source.listing_type === 'download' ? false : source.is_supply,
    should_auto_renew: source.should_auto_renew,
    shop_section_id: source.shop_section_id,
    shipping_profile_id: source.shipping_profile_id,
    return_policy_id: source.return_policy_id,
    readiness_state_id: source.readiness_state_id,
    processing_min: source.processing_min,
    processing_max: source.processing_max,
  };
  return buildListingBody({ ...base, ...changes, state: 'draft' });
}

export async function duplicateAndCustomizeListing({
  shopId,
  sourceListingId,
  changes = {},
  inventory,
  personalizationQuestions,
  copyImages = true,
  copyVideo = true,
  copyDigitalFiles = true,
  atomic = true,
  verify = true,
} = {}) {
  const sourceId = strictPositiveId(sourceListingId, 'source_listing_id');
  const source = await getListing({ listingId: sourceId });
  const sourceFiles = copyDigitalFiles && source.listing_type === 'download'
    ? await listDigitalListingFiles({ shopId, listingId: sourceId })
    : { results: [] };
  const stages = [];
  recordStage(stages, 'read_source', 'succeeded', { source_listing_id: sourceId });
  let listingId = null;
  try {
    const created = await createDraftListing({ shopId, listing: listingCopy(source, changes) });
    listingId = strictPositiveId(created?.listing_id, 'listing_id');
    recordStage(stages, 'create_draft', 'succeeded', { listing_id: listingId });

    const selectedInventory = inventory || source.inventory;
    if (selectedInventory && hasVariationInventoryForEtsy(selectedInventory)) {
      await updateListingInventory({ listingId, inventory: selectedInventory });
      recordStage(stages, 'inventory', 'succeeded');
    }
    const selectedQuestions = personalizationQuestions === undefined
      ? source.personalization?.personalization_questions
      : personalizationQuestions;
    if (selectedQuestions?.length) {
      await updateListingPersonalization({ shopId, listingId, questions: selectedQuestions });
      recordStage(stages, 'personalization', 'succeeded');
    }
    if (copyImages) {
      for (const [index, image] of (source.images || []).slice(0, MAX_COMPLETE_DRAFT_IMAGES).entries()) {
        await associateListingImage({
          shopId,
          listingId,
          listingImageId: image.listing_image_id,
          rank: image.rank || index + 1,
          ...(image.alt_text ? { altText: image.alt_text } : {}),
        });
        recordStage(stages, 'image', 'succeeded', { rank: image.rank || index + 1, source_listing_image_id: image.listing_image_id });
      }
    }
    if (copyVideo) {
      for (const video of (source.videos || []).slice(0, 1)) {
        await associateListingVideo({ shopId, listingId, videoId: video.video_id });
        recordStage(stages, 'video', 'succeeded', { source_video_id: video.video_id });
      }
    }
    if (copyDigitalFiles) {
      for (const [index, file] of (sourceFiles.results || []).slice(0, MAX_COMPLETE_DRAFT_FILES).entries()) {
        await associateDigitalListingFile({
          shopId,
          listingId,
          listingFileId: file.listing_file_id,
          rank: file.rank || index + 1,
        });
        recordStage(stages, 'digital_file', 'succeeded', { rank: file.rank || index + 1, source_listing_file_id: file.listing_file_id });
      }
    }
    const verification = verify ? await verifyDraft(shopId, listingId).catch(error => ({ warnings: [error.message] })) : null;
    if (verify) {
      recordStage(stages, 'verify', verification?.listing ? 'succeeded' : 'warning', verification?.listing ? {
        image_count: verification.image_count,
        video_count: verification.video_count,
        file_count: verification.file_count,
      } : { warnings: verification?.warnings || [] });
    }
    return { success: true, source_listing_id: sourceId, listing_id: listingId, state: 'draft', stages, verification };
  } catch (error) {
    recordStage(stages, 'workflow', 'failed', { error: error.message });
    const rollback = listingId && atomic ? await rollbackNewDraft(listingId, stages) : { attempted: false, succeeded: false };
    const result = { success: false, source_listing_id: sourceId, listing_id: listingId, stages, rollback };
    throw workflowError(
      rollback.succeeded ? `Duplicate failed and was rolled back: ${error.message}` : `Duplicate failed: ${error.message}`,
      rollback.succeeded ? 'DUPLICATE_ROLLED_BACK' : 'DUPLICATE_PARTIAL_FAILURE',
      error.status || 502,
      result,
    );
  }
}

export async function previewChange({ listingId, changes = {}, currentListing } = {}) {
  const id = strictPositiveId(listingId, 'listing_id');
  const current = currentListing || await getListing({ listingId: id });
  const normalized = buildListingUpdateBody(changes);
  const diff = [];
  for (const field of DIFF_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(normalized, field)) continue;
    const before = current[field] ?? null;
    const after = normalized[field] ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after)) diff.push({ field, before, after });
  }
  const risks = [];
  if (changes.state === 'active') risks.push('publishes_listing');
  if (changes.state === 'inactive') risks.push('deactivates_listing');
  if (normalized.listing_type && normalized.listing_type !== current.listing_type) risks.push('changes_listing_type');
  if (normalized.price !== undefined) risks.push('changes_price');
  return {
    dry_run: true,
    listing_id: id,
    title: current.title,
    has_changes: diff.length > 0,
    diff,
    risks,
    normalized_changes: normalized,
  };
}

export async function bulkCreateDrafts({ shopId, items, atomicPerItem = true, verify = false } = {}) {
  const batch = boundedArray(items, 'items', MAX_BULK_CREATE_ITEMS);
  if (!batch.length) throw workflowError('items must not be empty', 'INVALID_WORKFLOW_INPUT');
  const results = [];
  for (let index = 0; index < batch.length; index += 1) {
    try {
      const result = await createCompleteDraft({ ...batch[index], shopId, atomic: atomicPerItem, verify });
      results.push({ index, success: true, listing_id: result.listing_id, result });
    } catch (error) {
      results.push({ index, success: false, error: error.message, code: error.code, result: error.workflow_result || null });
    }
  }
  return { success: results.every(result => result.success), partial: results.some(result => result.success) && results.some(result => !result.success), count: results.length, results };
}

export async function bulkUpdateListings({ shopId, items, dryRun = false } = {}) {
  const batch = boundedArray(items, 'items', MAX_BULK_UPDATE_ITEMS);
  if (!batch.length) throw workflowError('items must not be empty', 'INVALID_WORKFLOW_INPUT');
  const results = [];
  for (let index = 0; index < batch.length; index += 1) {
    const item = batch[index] || {};
    try {
      const listingId = strictPositiveId(item.listingId ?? item.listing_id, 'listing_id');
      if (dryRun) {
        results.push({ index, success: true, listing_id: listingId, preview: await previewChange({ listingId, changes: item.changes || {} }) });
        continue;
      }
      const stages = [];
      if (item.changes && Object.keys(item.changes).length) {
        await updateListing({ shopId, listingId, changes: item.changes });
        recordStage(stages, 'listing', 'succeeded');
      }
      if (item.inventory) {
        await updateListingInventory({ listingId, inventory: item.inventory });
        recordStage(stages, 'inventory', 'succeeded');
      }
      if (item.personalizationQuestions?.length) {
        await updateListingPersonalization({ shopId, listingId, questions: item.personalizationQuestions });
        recordStage(stages, 'personalization', 'succeeded');
      }
      if (!stages.length) throw workflowError('Each update item must contain changes, inventory, or personalizationQuestions', 'INVALID_WORKFLOW_INPUT');
      results.push({ index, success: true, listing_id: listingId, stages });
    } catch (error) {
      results.push({ index, success: false, listing_id: item.listingId ?? item.listing_id ?? null, error: error.message, code: error.code || 'UPDATE_FAILED' });
    }
  }
  return { success: results.every(result => result.success), partial: results.some(result => result.success) && results.some(result => !result.success), dry_run: dryRun, count: results.length, results };
}
