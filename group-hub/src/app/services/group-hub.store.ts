// @ts-nocheck
import { Injectable, signal } from '@angular/core';
import { GROUPS_SNAPSHOT_KEY, LAST_MOVE_ACTION_KEY } from '@group-hub/shared/constants';

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

  async moveTabsToGroup(groupId, tabIds) {
    const response = await this.sendMessage({
      channel: 'tgm',
      type: 'moveTabsToGroup',
      groupId,
      tabIds
    });
    return response.result;
  }

  async restoreTabs(assignments) {
    const response = await this.sendMessage({
      channel: 'tgm',
      type: 'restoreTabsToGroups',
      assignments
    });
    return response.result;
  }

  async saveLastMoveAction(action) {
    try {
      const data = {
        ...action,
        timestamp: Date.now()
      };
      await chrome.storage.local.set({ [LAST_MOVE_ACTION_KEY]: data });
    } catch (error) {
      console.error('[GroupHub] failed to save last move action', error);
    }
  }

  async loadLastMoveAction() {
    try {
      const stored = await chrome.storage.local.get(LAST_MOVE_ACTION_KEY);
      const action = stored[LAST_MOVE_ACTION_KEY];
      if (action && this.isMoveActionValid(action)) {
        return action;
      }
      // Clean up expired action
      await this.clearLastMoveAction();
      return null;
    } catch (error) {
      console.error('[GroupHub] failed to load last move action', error);
      return null;
    }
  }

  async clearLastMoveAction() {
    try {
      await chrome.storage.local.remove(LAST_MOVE_ACTION_KEY);
    } catch (error) {
      console.error('[GroupHub] failed to clear last move action', error);
    }
  }

  isMoveActionValid(action) {
    if (!action || !action.timestamp) {
      return false;
    }
    // Expire after 24 hours
    const EXPIRE_MS = 24 * 60 * 60 * 1000;
    return Date.now() - action.timestamp < EXPIRE_MS;
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
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response?.error) {
        throw new Error(response.error);
      }
      return response;
    } catch (error) {
      if (this.isTransientMessagingError(error)) {
        await this.delay(150);
        const retryResponse = await chrome.runtime.sendMessage(message);
        if (retryResponse?.error) {
          throw new Error(retryResponse.error);
        }
        return retryResponse;
      }
      throw error;
    }
  }

  isTransientMessagingError(error) {
    const message = typeof error === 'string' ? error : error?.message ?? '';
    return (
      message.includes('Could not establish connection') ||
      message.includes('Receiving end does not exist')
    );
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
