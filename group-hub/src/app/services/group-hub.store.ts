// @ts-nocheck
import { Injectable, signal } from '@angular/core';
import { LAST_MOVE_ACTION_KEY } from '@group-hub/shared/constants';

@Injectable({ providedIn: 'root' })
export class GroupHubStore {
  snapshot = signal(null);
  loading = signal(false);
  lastError = signal(null);

  initialized = false;
  messageListener;

  async init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
      throw new Error('Chrome extension APIs are unavailable.');
    }

    this.attachMessageListener();
    await this.refresh();
  }

  async refresh() {
    try {
      this.loading.set(!this.snapshot());
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

  async importData(payload, mode = 'append') {
    const response = await this.sendMessage({
      channel: 'tgm',
      type: 'import',
      payload,
      mode
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

  async storageRequest(type, params = {}) {
    const response = await this.sendMessage({ channel: 'tgm', type, ...params });
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

  attachMessageListener() {
    this.messageListener = (message) => {
      if (message?.channel === 'tgm' && message.type === 'snapshotChanged') {
        this.snapshot.set(message.snapshot);
      }
    };
    chrome.runtime.onMessage.addListener(this.messageListener);
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
