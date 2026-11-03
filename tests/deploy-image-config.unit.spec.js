import { expect, test } from '@playwright/test';
import fs from 'node:fs';

test.describe('VPS image provider deployment guard', () => {
  test('refuses a Codex OAuth runtime outside the Responses image pipeline', () => {
    const deploy = fs.readFileSync(new URL('../scripts/deploy-vps-staging.sh', import.meta.url), 'utf8');

    expect(deploy).toContain('require_supported_runtime_image_pipeline');
    expect(deploy).toContain('EXTERNAL_IMAGE_ADAPTER=openai_responses');
    expect(deploy).toContain('EXTERNAL_AI_IMAGE_PATH=/v1/responses');
    expect(deploy).toMatch(/if \[\[ "\$model" == codex\/\* \]\]/);
  });
});
