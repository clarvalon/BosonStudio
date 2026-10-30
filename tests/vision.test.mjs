import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { imageDimensions, contextualImageIds, visionMessage } from '../lib/vision.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDFsAAAAASUVORK5CYII=', 'base64');
test('actual image bytes and IDs reach the multimodal context; removed images are excluded', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boson-vision-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'media'));
  await writeFile(path.join(directory, 'media', 'image-one.png'), png);
  const asset = { id: 'image-one', name: 'A reference', kind: 'image', extension: '.png', mime: 'image/png', metadata: { width: 1, height: 1 } };
  const store = { directory, data: { assets: [asset], messages: [{ role: 'user', content: 'Describe this.', assetIds: ['image-one'] }] } };
  assert.deepEqual(imageDimensions(png), { width: 1, height: 1 });
  assert.deepEqual(contextualImageIds(store), ['image-one']);
  const message = await visionMessage(store, ['image-one']);
  const image = message.content.find(part => part.type === 'image_url');
  assert.equal(image.image_url.url, `data:image/png;base64,${png.toString('base64')}`);
  assert.ok(message.content.some(part => part.text?.includes('Image ID: image-one')));
  asset.deletedAt = new Date().toISOString();
  assert.deepEqual(contextualImageIds(store), []);
  await assert.rejects(visionMessage(store, ['image-one']), /unavailable/);
});
