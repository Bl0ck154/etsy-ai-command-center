import fs from 'node:fs';

import { createMessageLearningRepository } from '../../api/messages/learning-feedback-repository.js';

const [encodedPayload, readyFile, goFile] = process.argv.slice(2);
const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));

fs.writeFileSync(readyFile, 'ready');
while (!fs.existsSync(goFile)) {
  await new Promise(resolve => setTimeout(resolve, 5));
}

try {
  const repository = createMessageLearningRepository({ file: payload.file });
  const record = await repository.captureProposal(payload.input);
  process.stdout.write(JSON.stringify({ ok: true, id: record.id }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    code: error?.code || null,
    message: error?.message || String(error),
  }));
  process.exitCode = 1;
}
