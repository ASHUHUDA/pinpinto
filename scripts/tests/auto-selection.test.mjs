import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

class FakeElement {
  constructor() {
    this.attributes = new Map();
    this.classList = createClassList();
    this.dataset = {};
    this.textContent = '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

function createClassList() {
  const tokens = new Set();
  return {
    add(...values) { values.forEach((value) => tokens.add(value)); },
    remove(...values) { values.forEach((value) => tokens.delete(value)); },
    contains(value) { return tokens.has(value); }
  };
}

function imageRecord(id, source = 'search-result') {
  const checkbox = new FakeElement();
  const element = new FakeElement();
  const container = new FakeElement();
  const overlay = new FakeElement();
  overlay.querySelector = (selector) => selector === '.pinvault-checkbox' ? checkbox : null;
  return {
    record: {
      id,
      element,
      container,
      controls: new FakeElement(),
      overlay,
      url: `https://i.pinimg.com/originals/${id}.jpg`,
      title: id,
      board: 'Pinterest',
      domain: 'www.pinterest.com',
      sourceKey: id,
      source
    },
    checkbox,
    element,
    container,
    overlay
  };
}

test('selectImage is idempotent and selectAll preserves compatibility selection markers', async () => {
  globalThis.HTMLElement = FakeElement;
  const { ContentSessionStore } = await loadTsModule('src/content/session-store.ts');
  const store = new ContentSessionStore();
  const first = imageRecord('image-1');
  const second = imageRecord('image-2');
  store.addImage(first.record);
  store.addImage(second.record);

  assert.equal(store.selectImage('image-1'), true);
  assert.equal(store.selectImage('image-1'), true);
  assert.deepEqual([...store.selectedImages], ['image-1']);
  assert.equal(first.checkbox.textContent, '[x]');
  assert.equal(first.element.attributes.get('data-pinvault-selected'), 'true');
  assert.equal(first.overlay.classList.contains('selected'), true);
  assert.equal(first.container.classList.contains('pinvault-selected'), true);

  store.selectAllImages();
  assert.deepEqual([...store.selectedImages], ['image-1', 'image-2']);
  assert.equal(second.checkbox.textContent, '[x]');
  assert.equal(second.element.attributes.get('data-pinvault-selected'), 'true');
});

test('auto-selection affects only newly registered eligible images and never rebounds a manual deselection', async () => {
  globalThis.HTMLElement = FakeElement;
  const [{ AutoSelectionController }, { ContentSessionStore }] = await Promise.all([
    loadTsModule('src/content/auto-selection.ts'),
    loadTsModule('src/content/session-store.ts')
  ]);
  const store = new ContentSessionStore();
  const controller = new AutoSelectionController((imageId) => store.selectImage(imageId));

  const existing = imageRecord('existing');
  store.addImage(existing.record);
  assert.equal(controller.registerImage(existing.record.id, true), false);

  controller.enable();
  assert.equal(store.selectedImages.has(existing.record.id), false);

  const future = imageRecord('future');
  store.addImage(future.record);
  assert.equal(controller.registerImage(future.record.id, true), true);
  assert.equal(store.selectedImages.has(future.record.id), true);

  store.toggleImageSelection(future.record.id);
  assert.equal(store.selectedImages.has(future.record.id), false);
  assert.equal(controller.registerImage(future.record.id, true), false);
  assert.equal(store.selectedImages.has(future.record.id), false);

  const recommendation = imageRecord('recommendation', 'recommendation');
  store.addImage(recommendation.record);
  assert.equal(controller.registerImage(recommendation.record.id, false), false);
  assert.equal(store.selectedImages.has(recommendation.record.id), false);

  controller.disable();
  const afterStop = imageRecord('after-stop');
  store.addImage(afterStop.record);
  assert.equal(controller.registerImage(afterStop.record.id, true), false);
  assert.equal(store.selectedImages.has(afterStop.record.id), false);
  assert.equal(store.selectedImages.has(existing.record.id), false);
});
