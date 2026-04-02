/**
 * builting-resolve — NormalizeClaims + ResolveClaims Lambda.
 * Reads claims.json from S3, normalizes, resolves, and produces:
 *   - normalized_claims.json
 *   - canonical_observed.json
 *   - resolution_report.json
 *   - identity_map.json
 *
 * Phase 2 of the v2 pipeline refactor. During transition, the downstream
 * Transform Lambda still reads CSS — this Lambda writes new artifacts in parallel.
 */

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { normalizeClaims } from './normalize.mjs';
import { resolveClaims } from './resolve.mjs';
import { assignIdentities } from './identity.mjs';
import { buildCanonicalObservedEnvelope } from './schemas.mjs';
import { validateSpatialSchema } from './spatialValidation.mjs';

const s3 = new S3Client({});
const DATA_BUCKET = process.env.DATA_BUCKET || 'builting-data';

export const handler = async (event) => {
  console.log('ResolveClaims input:', JSON.stringify({
    claimsS3Key: event.claimsS3Key,
    userId: event.userId,
    renderId: event.renderId,
    bucket: event.bucket,
  }));

  const { claimsS3Key, userId, renderId, bucket } = event;
  const dataBucket = bucket || DATA_BUCKET;
  const revision = event.renderRevision || 1;

  // Idempotency: if output artifacts already exist, return cached result
  const prefix = `uploads/${userId}/${renderId}/pipeline/v${revision}`;
  const idempotencyKey = `${prefix}/normalized_claims.json`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: dataBucket, Key: idempotencyKey }));
    console.log(`[idempotency] normalized_claims.json exists — returning cached result`);
    const reportObj = await s3.send(new GetObjectCommand({ Bucket: dataBucket, Key: `${prefix}/resolution_report.json` }));
    const report = JSON.parse(await reportObj.Body.transformToString());
    return {
      normalizedClaimsS3Key: `${prefix}/normalized_claims.json`,
      canonicalObservedS3Key: `${prefix}/canonical_observed.json`,
      resolutionReportS3Key: `${prefix}/resolution_report.json`,
      identityMapS3Key: `${prefix}/identity_map.json`,
      observationCount: report.summary?.observationsProduced || 0,
      rejectedCount: report.droppedClaims?.length || 0,
      ambiguousCount: report.summary?.ambiguousGroups || 0,
    };
  } catch (err) {
    if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) throw err;
  }

  // No-op if claims weren't produced (legacy renders before Phase 1)
  if (!claimsS3Key) {
    console.log('No claimsS3Key — skipping resolve (legacy render)');
    return {
      normalizedClaimsS3Key: null,
      canonicalObservedS3Key: null,
      resolutionReportS3Key: null,
      identityMapS3Key: null,
      observationCount: 0,
      rejectedCount: 0,
      ambiguousCount: 0,
    };
  }

  const startTime = Date.now();

  try {
    // 1. Read claims.json from S3
    console.log(`Reading claims from s3://${dataBucket}/${claimsS3Key}`);
    const claimsObj = await s3.send(new GetObjectCommand({
      Bucket: dataBucket,
      Key: claimsS3Key,
    }));
    const claimsBody = await claimsObj.Body.transformToString();
    const claimsDoc = JSON.parse(claimsBody);
    console.log(`Claims loaded: ${claimsDoc.claims?.length || 0} claims, domain=${claimsDoc.domain}`);

    // 2. Normalize claims
    const normalizedDoc = normalizeClaims(claimsDoc);

    // 3. Spatial schema validation — after normalization, before resolve
    const { validatedDoc, validationSummary } = validateSpatialSchema(normalizedDoc);

    // 4. Resolve claims → observations + report
    const { observations, resolutionReport } = resolveClaims(validatedDoc);

    // 5. Assign identities
    const { identityMap, observationsWithIds } = assignIdentities(observations, { revision });

    // Update resolution report with identity assignments
    resolutionReport.identityAssignments = identityMap.assignments.map(a => ({
      canonicalId: a.canonical_id,
      matchMethod: 'new_assignment',
      matchedFrom: null,
      matched_from_revision: a.matched_from_revision,
      match_confidence: a.match_confidence,
      match_reason: a.match_reason,
      newAssignment: true,
    }));

    // 6. Build canonical_observed envelope (validatedDoc carries the validated claims)
    const facility = validatedDoc.facilityMeta ? {
      name: validatedDoc.facilityMeta.name,
      type: validatedDoc.facilityMeta.type,
      description: validatedDoc.facilityMeta.description,
      units: validatedDoc.facilityMeta.units || 'M',
      origin: validatedDoc.facilityMeta.origin || { x: 0, y: 0, z: 0 },
      axes: validatedDoc.facilityMeta.axes || 'RIGHT_HANDED_Z_UP',
    } : null;

    const canonicalObserved = {
      ...buildCanonicalObservedEnvelope(
        observationsWithIds,
        validatedDoc.domain,
        facility,
        {
          claimsConsumed: validatedDoc.claims?.length || 0,
          observationsProduced: observationsWithIds.length,
          rejectedClaims: resolutionReport.droppedClaims.length,
        }
      ),
      validation_summary: validationSummary,
    };

    // 7. Write all 4 artifacts to S3 in parallel
    const prefix = `uploads/${userId}/${renderId}/pipeline/v${revision}`;
    const keys = {
      normalizedClaims: `${prefix}/normalized_claims.json`,
      canonicalObserved: `${prefix}/canonical_observed.json`,
      resolutionReport: `${prefix}/resolution_report.json`,
      identityMap: `${prefix}/identity_map.json`,
    };

    await Promise.all([
      writeToS3(dataBucket, keys.normalizedClaims, validatedDoc),
      writeToS3(dataBucket, keys.canonicalObserved, canonicalObserved),
      writeToS3(dataBucket, keys.resolutionReport, resolutionReport),
      writeToS3(dataBucket, keys.identityMap, identityMap),
    ]);

    const durationMs = Date.now() - startTime;
    console.log(`ResolveClaims complete in ${durationMs}ms: ${observationsWithIds.length} observations, ${resolutionReport.droppedClaims.length} dropped, ${resolutionReport.summary.ambiguousGroups} ambiguous`);

    return {
      normalizedClaimsS3Key: keys.normalizedClaims,
      canonicalObservedS3Key: keys.canonicalObserved,
      resolutionReportS3Key: keys.resolutionReport,
      identityMapS3Key: keys.identityMap,
      observationCount: observationsWithIds.length,
      rejectedCount: resolutionReport.droppedClaims.length,
      ambiguousCount: resolutionReport.summary.ambiguousGroups,
    };
  } catch (error) {
    console.error('ResolveClaims error:', error);
    throw error;
  }
};

/**
 * Write JSON to S3.
 */
async function writeToS3(bucket, key, data) {
  const body = JSON.stringify(data);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'application/json',
  }));
  console.log(`Saved: s3://${bucket}/${key} (${body.length} bytes)`);
}
