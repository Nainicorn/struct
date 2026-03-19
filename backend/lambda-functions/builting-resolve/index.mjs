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

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { normalizeClaims } from './normalize.mjs';
import { resolveClaims } from './resolve.mjs';
import { assignIdentities } from './identity.mjs';
import { buildCanonicalObservedEnvelope } from './schemas.mjs';

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

    // 3. Resolve claims → observations + report
    const { observations, resolutionReport } = resolveClaims(normalizedDoc);

    // 4. Assign identities
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

    // 5. Build canonical_observed envelope
    const facility = normalizedDoc.facilityMeta ? {
      name: normalizedDoc.facilityMeta.name,
      type: normalizedDoc.facilityMeta.type,
      description: normalizedDoc.facilityMeta.description,
      units: normalizedDoc.facilityMeta.units || 'M',
      origin: normalizedDoc.facilityMeta.origin || { x: 0, y: 0, z: 0 },
      axes: normalizedDoc.facilityMeta.axes || 'RIGHT_HANDED_Z_UP',
    } : null;

    const canonicalObserved = buildCanonicalObservedEnvelope(
      observationsWithIds,
      normalizedDoc.domain,
      facility,
      {
        claimsConsumed: normalizedDoc.claims?.length || 0,
        observationsProduced: observationsWithIds.length,
        rejectedClaims: resolutionReport.droppedClaims.length,
      }
    );

    // 6. Write all 4 artifacts to S3 in parallel
    const prefix = `uploads/${userId}/${renderId}/pipeline/v${revision}`;
    const keys = {
      normalizedClaims: `${prefix}/normalized_claims.json`,
      canonicalObserved: `${prefix}/canonical_observed.json`,
      resolutionReport: `${prefix}/resolution_report.json`,
      identityMap: `${prefix}/identity_map.json`,
    };

    await Promise.all([
      writeToS3(dataBucket, keys.normalizedClaims, normalizedDoc),
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
