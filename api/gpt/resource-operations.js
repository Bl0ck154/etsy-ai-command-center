import * as Etsy from './etsy-service.js';

function inputError(message, code = 'INVALID_RESOURCE_ACTION') {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function actionOf(body) {
  const action = String(body?.action || '').trim();
  if (!action) throw inputError('action is required');
  return action;
}

function page(body) {
  return { limit: body?.limit, offset: body?.offset };
}

export async function readEtsyResource({ body = {}, shopId }) {
  switch (actionOf(body)) {
    case 'shop': return Etsy.getShop({ shopId });
    case 'shop_sections': return Etsy.getShopSections({ shopId });
    case 'shop_section': return Etsy.getShopSection({ shopId, sectionId: body.section_id });
    case 'shipping_profiles': return Etsy.getShippingProfiles({ shopId });
    case 'shipping_profile': return Etsy.getShippingProfile({ shopId, shippingProfileId: body.shipping_profile_id });
    case 'shipping_destinations': return Etsy.getShippingProfileDestinations({ shopId, shippingProfileId: body.shipping_profile_id, limit: body.limit, offset: body.offset });
    case 'shipping_upgrades': return Etsy.getShippingProfileUpgrades({ shopId, shippingProfileId: body.shipping_profile_id });
    case 'return_policies': return Etsy.getReturnPolicies({ shopId });
    case 'return_policy': return Etsy.getReturnPolicy({ shopId, returnPolicyId: body.return_policy_id });
    case 'return_policy_listings': return Etsy.getListingsByReturnPolicy({ shopId, returnPolicyId: body.return_policy_id, ...page(body) });
    case 'readiness_states': return Etsy.getReadinessStateDefinitions({ shopId, limit: body.limit });
    case 'production_partners': return Etsy.getShopProductionPartners({ shopId });
    case 'featured_listings': return Etsy.getFeaturedListings({ shopId, ...page(body) });
    case 'listing_inventory': return Etsy.getListingInventory({ listingId: body.listing_id });
    case 'listing_product': return Etsy.getListingProduct({ listingId: body.listing_id, productId: body.product_id });
    case 'listing_offering': return Etsy.getListingOffering({ listingId: body.listing_id, productId: body.product_id, offeringId: body.offering_id });
    case 'listing_personalization': return Etsy.getListingPersonalization({ listingId: body.listing_id });
    case 'listing_images': return Etsy.getListingImages({ listingId: body.listing_id });
    case 'listing_image': return Etsy.getListingImage({ listingId: body.listing_id, listingImageId: body.image_id });
    case 'listing_videos': return Etsy.getListingVideos({ listingId: body.listing_id });
    case 'digital_files': return Etsy.listDigitalListingFiles({ shopId, listingId: body.listing_id });
    case 'digital_file': return Etsy.getDigitalListingFile({ shopId, listingId: body.listing_id, listingFileId: body.file_id });
    case 'variation_images': return Etsy.getListingVariationImages({ shopId, listingId: body.listing_id });
    case 'listing_properties': return Etsy.getListingProperties({ shopId, listingId: body.listing_id });
    case 'listing_property': return Etsy.getListingProperty({ shopId, listingId: body.listing_id, propertyId: body.property_id });
    case 'listing_translation': return Etsy.getListingTranslation({ shopId, listingId: body.listing_id, language: body.language });
    case 'seller_taxonomy': return Etsy.getSellerTaxonomy();
    case 'taxonomy_properties': return Etsy.getTaxonomyProperties({ taxonomyId: body.taxonomy_id });
    case 'reviews': return Etsy.listReviews({ shopId, ...page(body) });
    case 'discounts': return Etsy.listDiscounts({ shopId, limit: body.limit });
    case 'discount': return Etsy.getDiscount({ shopId, discountId: body.discount_id });
    default: throw inputError(`Unsupported read action: ${body.action}`);
  }
}

export async function manageShopResource({ body = {}, shopId }) {
  switch (actionOf(body)) {
    case 'update_shop': return Etsy.updateShop({ shopId, changes: body.data });
    case 'create_section': return Etsy.createShopSection({ shopId, title: body.data?.title });
    case 'update_section': return Etsy.updateShopSection({ shopId, sectionId: body.section_id, title: body.data?.title });
    case 'delete_section': return Etsy.deleteShopSection({ shopId, sectionId: body.section_id });
    case 'create_shipping_profile': return Etsy.createShippingProfile({ shopId, profile: body.data });
    case 'update_shipping_profile': return Etsy.updateShippingProfile({ shopId, shippingProfileId: body.shipping_profile_id, changes: body.data });
    case 'delete_shipping_profile': return Etsy.deleteShippingProfile({ shopId, shippingProfileId: body.shipping_profile_id });
    case 'create_shipping_destination': return Etsy.createShippingProfileDestination({ shopId, shippingProfileId: body.shipping_profile_id, destination: body.data });
    case 'update_shipping_destination': return Etsy.updateShippingProfileDestination({ shopId, shippingProfileId: body.shipping_profile_id, destinationId: body.destination_id, changes: body.data });
    case 'delete_shipping_destination': return Etsy.deleteShippingProfileDestination({ shopId, shippingProfileId: body.shipping_profile_id, destinationId: body.destination_id });
    case 'create_shipping_upgrade': return Etsy.createShippingProfileUpgrade({ shopId, shippingProfileId: body.shipping_profile_id, upgrade: body.data });
    case 'update_shipping_upgrade': return Etsy.updateShippingProfileUpgrade({ shopId, shippingProfileId: body.shipping_profile_id, upgradeId: body.upgrade_id, changes: body.data });
    case 'delete_shipping_upgrade': return Etsy.deleteShippingProfileUpgrade({ shopId, shippingProfileId: body.shipping_profile_id, upgradeId: body.upgrade_id });
    case 'create_return_policy': return Etsy.createReturnPolicy({ shopId, policy: body.data });
    case 'update_return_policy': return Etsy.updateReturnPolicy({ shopId, returnPolicyId: body.return_policy_id, policy: body.data });
    case 'delete_return_policy': return Etsy.deleteReturnPolicy({ shopId, returnPolicyId: body.return_policy_id });
    case 'consolidate_return_policies': return Etsy.consolidateReturnPolicies({ shopId, sourceReturnPolicyId: body.source_return_policy_id, destinationReturnPolicyId: body.destination_return_policy_id });
    default: throw inputError(`Unsupported shop-management action: ${body.action}`);
  }
}

export async function manageAdvancedListingResource({ body = {}, shopId, ensureDraft }) {
  const action = actionOf(body);
  await ensureDraft(body.listing_id);
  switch (action) {
    case 'update_inventory': return Etsy.updateAndVerifyListingInventory({ listingId: body.listing_id, inventory: body.data });
    case 'update_personalization': return Etsy.updateListingPersonalization({ shopId, listingId: body.listing_id, questions: body.data?.personalization_questions });
    case 'set_variation_images': return Etsy.updateListingVariationImages({ shopId, listingId: body.listing_id, variationImages: body.data?.variation_images });
    case 'create_translation': return Etsy.createListingTranslation({ shopId, listingId: body.listing_id, language: body.language, translation: body.data });
    case 'update_translation': return Etsy.updateListingTranslation({ shopId, listingId: body.listing_id, language: body.language, translation: body.data });
    case 'upsert_property': return Etsy.updateListingProperty({ shopId, listingId: body.listing_id, propertyId: body.property_id, property: body.data });
    default: throw inputError(`Unsupported advanced-listing action: ${body.action}`);
  }
}

export async function deleteAdvancedListingResource({ body = {}, shopId, ensureDraft }) {
  const action = actionOf(body);
  await ensureDraft(body.listing_id);
  switch (action) {
    case 'delete_personalization': return Etsy.deleteListingPersonalization({ shopId, listingId: body.listing_id });
    case 'delete_property': return Etsy.deleteListingProperty({ shopId, listingId: body.listing_id, propertyId: body.property_id });
    default: throw inputError(`Unsupported advanced-listing delete action: ${body.action}`);
  }
}

export async function manageListingMedia({ body = {}, shopId, ensureDraft }) {
  const action = actionOf(body);
  await ensureDraft(body.listing_id);
  switch (action) {
    case 'update_image_alt_text': return Etsy.updateListingImageAltText({ shopId, listingId: body.listing_id, listingImageId: body.image_id, altText: body.alt_text });
    case 'associate_image': return Etsy.associateListingImage({ shopId, listingId: body.listing_id, listingImageId: body.image_id, rank: body.rank, altText: body.alt_text });
    case 'associate_video': return Etsy.associateListingVideo({ shopId, listingId: body.listing_id, videoId: body.video_id });
    case 'associate_digital_file': return Etsy.associateDigitalListingFile({ shopId, listingId: body.listing_id, listingFileId: body.file_id, rank: body.rank });
    default: throw inputError(`Unsupported media action: ${body.action}`);
  }
}

export async function deleteListingMediaResource({ body = {}, shopId, ensureDraft }) {
  const action = actionOf(body);
  await ensureDraft(body.listing_id);
  switch (action) {
    case 'delete_image': return Etsy.deleteListingImage({ shopId, listingId: body.listing_id, listingImageId: body.image_id });
    case 'delete_video': return Etsy.deleteListingVideo({ shopId, listingId: body.listing_id, videoId: body.video_id });
    case 'delete_digital_file': return Etsy.deleteDigitalListingFile({ shopId, listingId: body.listing_id, listingFileId: body.file_id });
    default: throw inputError(`Unsupported media delete action: ${body.action}`);
  }
}

export async function readFinancialResource({ body = {}, shopId }) {
  switch (actionOf(body)) {
    case 'aggregated_stats': return Etsy.getShopStats({ shopId, kind: body.kind, days: body.days });
    case 'receipts': return Etsy.listReceipts({ shopId, ...page(body), minCreated: body.min_created, maxCreated: body.max_created, wasPaid: body.was_paid, wasShipped: body.was_shipped });
    case 'receipt': return Etsy.getReceipt({ shopId, receiptId: body.receipt_id });
    case 'transactions': return Etsy.listTransactions({ shopId, ...page(body) });
    case 'transaction': return Etsy.getTransaction({ shopId, transactionId: body.transaction_id });
    case 'listing_transactions': return Etsy.getListingTransactions({ shopId, listingId: body.listing_id, ...page(body) });
    case 'receipt_transactions': return Etsy.getReceiptTransactions({ shopId, receiptId: body.receipt_id, ...page(body) });
    case 'payments': return Etsy.getPayments({ shopId, paymentIds: body.payment_ids });
    case 'receipt_payments': return Etsy.getReceiptPayments({ shopId, receiptId: body.receipt_id });
    case 'ledger_entries': return Etsy.getLedgerEntries({ shopId, minCreated: body.min_created, maxCreated: body.max_created, ...page(body) });
    case 'ledger_entry': return Etsy.getLedgerEntry({ shopId, ledgerEntryId: body.ledger_entry_id });
    case 'ledger_entry_payments': return Etsy.getLedgerEntryPayments({ shopId, ledgerEntryIds: body.ledger_entry_ids });
    default: throw inputError(`Unsupported financial-read action: ${body.action}`);
  }
}

export async function manageDiscountResource({ body = {}, shopId }) {
  switch (actionOf(body)) {
    case 'create': return Etsy.createDiscount({ shopId, discount: body.data });
    case 'update': return Etsy.updateDiscount({ shopId, discountId: body.discount_id, changes: body.data });
    case 'delete': return Etsy.deleteDiscount({ shopId, discountId: body.discount_id });
    default: throw inputError(`Unsupported discount action: ${body.action}`);
  }
}
