// @ts-nocheck
import { Injectable, signal } from '@angular/core';
import { GROUPS_SNAPSHOT_KEY } from '@group-hub/shared/constants';

@Injectable({ providedIn: 'root' })
export class GroupHubStore {
  snapshot = signal(null);
  loading = signal(false);
  lastError = signal(null);

  initialized = false;
  storageListener;

  async init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      throw new Error('Chrome extension APIs are unavailable.');
    }

    await this.loadSnapshotFromStorage();
    this.attachStorageListener();
    await this.refresh();
  }

  async refresh() {
    try {
      this.loading.set(true);
      this.lastError.set(null);
      const response = await this.sendMessage({
        channel: 'tgm',
        type: 'refresh'
      });
      if (response?.snapshot) {
        this.snapshot.set(response.snapshot);
      }
    } catch (error) {
      console.error('[GroupHub] refresh failed', error);
      this.lastError.set('Unable to refresh tab groups.');
    } finally {
      this.loading.set(false);
    }
  }

  async exportData() {
    const response = await this.sendMessage({
      channel: 'tgm',
      type: 'export'
    });
    return response.data;
  }

  async importData(payload) {
    const response = await this.sendMessage({
      channel: 'tgm',
      type: 'import',
      payload
    });
    return response.result;
  }

  async openGroup(groupId) {
    const response = await this.sendMessage({
      channel: 'tgm',
      type: 'openGroup',
      groupId
    });
    return response.result;
  }

  async loadSnapshotFromStorage() {
    try {
      const stored = await chrome.storage.local.get(GROUPS_SNAPSHOT_KEY);
      const snapshot = stored[GROUPS_SNAPSHOT_KEY];
      if (snapshot) {
        this.snapshot.set(snapshot);
      }
    } catch (error) {
      console.error('[GroupHub] failed to load snapshot from storage', error);
    }
  }

  attachStorageListener() {
    if (this.storageListener) {
      chrome.storage.onChanged.removeListener(this.storageListener);
    }

    this.storageListener = (changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }
      const entry = changes[GROUPS_SNAPSHOT_KEY];
      if (entry && entry.newValue) {
        this.snapshot.set(entry.newValue);
      }
    };

    chrome.storage.onChanged.addListener(this.storageListener);
  }

  async sendMessage(message) {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      throw new Error('Chrome extension APIs are unavailable.');
    }
    const response = await chrome.runtime.sendMessage(message);
    if (response?.error) {
      throw new Error(response.error);
    }
    return response;
  }
}
