// @ts-nocheck
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  getBackupStatusForHandle,
  readBackupFile,
  writePreRunBackup,
  writeRotatingBackup
} from '@group-hub/shared/backup-files';
import {
  getChosenBackupHandle,
  getChosenHandleIfAllowed,
  getProfileBackupHandle,
  setBackupDirectoryHandle
} from '@group-hub/shared/backup-storage';
import { BACKUP_SETTINGS_KEY, PRE_RUN_BACKUP_FILE_NAME, STORAGE_RUN_PROGRESS_KEY } from '@group-hub/shared/constants';
import { STORAGE_MODE_STALE, STORAGE_MODE_WINDOW } from '@group-hub/shared/storage-plan';
import { GroupHubStore } from './services/group-hub.store';

const VIEW_MODE = {
  GROUPS: 'group-only',
  PREVIEW: 'preview',
  ALL_TABS: 'all-tabs'
};

const COLOR_PALETTE = {
  grey: '#9aa0a6',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#fbbc04',
  green: '#188038',
  pink: '#d96570',
  purple: '#9334e6',
  cyan: '#12b5cb',
  orange: '#ff8b02'
};

const BACKUP_SETUP_QUERY = 'backup-setup';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App implements OnInit, AfterViewInit, OnDestroy {
  store = inject(GroupHubStore);

  searchTerm = signal('');
  sortMode = signal('name-asc');
  viewMode = signal(VIEW_MODE.GROUPS);
  expandedGroups = signal(new Set());
  collapsedGroups = signal(new Set());
  statusMessage = signal(null);
  utilityMenuVisible = signal(false);
  backupPanelVisible = signal(false);
  backupStatus = signal(null);
  restoreChoice = signal(null);
  pendingImportPayload = signal(null);
  selectedTabIds = signal([]);
  lastMoveAction = signal(null); // Keep for backward compatibility, but will load from storage

  storagePanel = signal(null);
  storageRunProgress = signal(null);
  popOutChoice = signal(null);

  storageModes = { stale: STORAGE_MODE_STALE, window: STORAGE_MODE_WINDOW };

  searchDebounceTimer;

  snapshot = computed(() => this.store.snapshot());
  loading = computed(() => this.store.loading());
  errorText = computed(() => this.store.lastError());
  searchActive = computed(() => this.searchTerm().trim().length > 0);

  filteredGroups = computed(() => this.computeFilteredGroups());
  totalGroups = computed(() => (this.snapshot()?.groups.length ?? 0));
  visibleGroupCount = computed(() => this.filteredGroups().length);
  totalVisibleTabs = computed(() =>
    this.filteredGroups().reduce((acc, entry) => acc + entry.group.tabCount, 0)
  );
  selectionCount = computed(() => this.selectedTabIds().length);
  lastMoveStatusText = computed(() => {
    const action = this.lastMoveAction();
    if (!action) return '';
    const count = action.movedTabIds?.length ?? 0;
    const groupName = this.getGroupName(action.targetGroupId) || 'Unknown group';
    return `${count} tab${count === 1 ? '' : 's'} moved to ${groupName}`;
  });
  backupCanRestore = computed(() => Boolean(this.backupStatus()?.latestBackup));
  preRunBackupTitle = computed(() => {
    const preRunBackup = this.backupStatus()?.preRunBackup;
    return preRunBackup
      ? `Will restore the backup from before the last storage run, ${this.formatTimestamp(preRunBackup.generatedAt)}`
      : '';
  });
  backupRestoreTitle = computed(() => {
    const latestBackup = this.backupStatus()?.latestBackup;
    if (!latestBackup) {
      return 'No backup available';
    }
    return `Will restore from last backup at ${this.formatTimestamp(latestBackup.generatedAt)}`;
  });

  @ViewChild('importInput') importInput;
  @ViewChild('searchInput') searchInput: ElementRef<HTMLInputElement>;

  statusTimeout;
  dateFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
  openedForBackupSetup = location.search.includes(BACKUP_SETUP_QUERY);
  focusHandler = () => {
    void this.store.refresh();
    void this.loadSelectedTabs();
  };

  async ngOnInit() {
    this.backupPanelVisible.set(this.openedForBackupSetup);
    await this.watchStorageRunProgress();
    try {
      await this.store.init();
      await this.loadLastMoveAction();
      await this.loadBackupStatus();
    } catch (error) {
      console.error('[GroupHub] initialization failed', error);
      this.flashStatus('Chrome extension APIs unavailable.', 'error');
    }
  }

  ngAfterViewInit() {
    window.addEventListener('focus', this.focusHandler);
    void this.loadSelectedTabs();
    // Focus search input for immediate typing
    if (this.searchInput?.nativeElement) {
      this.searchInput.nativeElement.focus();
    }
  }

  ngOnDestroy() {
    window.removeEventListener('focus', this.focusHandler);
    globalThis.chrome?.storage?.onChanged?.removeListener(this.storageRunProgressListener);
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
  }

  trackGroup = (_index, entry) => entry.group.id;
  trackTab = (_index, tab) => tab.id;

  onSearchChange(term) {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    this.searchDebounceTimer = setTimeout(() => {
      this.searchTerm.set(term);
      this.searchDebounceTimer = undefined;
    }, 200);
  }

  onSortChange(mode) {
    this.sortMode.set(mode);
  }

  setViewMode(mode) {
    if (this.viewMode() === mode) {
      return;
    }
    this.viewMode.set(mode);
    this.expandedGroups.set(new Set());
    this.collapsedGroups.set(new Set());
  }

  toggleGroupExpansion(groupId) {
    if (this.viewMode() === VIEW_MODE.ALL_TABS) {
      const next = new Set(this.collapsedGroups());
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      this.collapsedGroups.set(next);
    } else {
      const next = new Set(this.expandedGroups());
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      this.expandedGroups.set(next);
    }
  }

  async activateGroup(groupId, event) {
    if (event?.stopPropagation) {
      event.stopPropagation();
      event.preventDefault();
    }

    if (typeof groupId !== 'number') {
      return;
    }

    try {
      const info = await this.store.storageRequest('storageGroupInfo', { groupId });
      if (info?.inStorage) {
        if (info.contextMembers.length) {
          this.popOutChoice.set({ groupId, members: info.contextMembers });
        } else {
          await this.popOutGroup(groupId, 'group');
        }
        return;
      }
      await this.store.openGroup(groupId);
      try {
        window.close();
      } catch (closeError) {
        console.debug('[GroupHub] unable to close popover window', closeError);
      }
    } catch (error) {
      console.error('[GroupHub] activate group failed', error);
      this.flashStatus(this.errorMessage(error, 'Unable to open the group.'), 'error');
    }
  }

  count(value, noun) {
    return `${value} ${noun}${value === 1 ? '' : 's'}`;
  }

  async targetWindowFor(mode) {
    return mode === STORAGE_MODE_WINDOW ? (await chrome.windows.getCurrent()).id : undefined;
  }

  storageRunProgressListener = (changes, area) => {
    if (area === 'session' && changes[STORAGE_RUN_PROGRESS_KEY]) {
      this.storageRunProgress.set(changes[STORAGE_RUN_PROGRESS_KEY].newValue ?? null);
    }
  };

  async watchStorageRunProgress() {
    const session = globalThis.chrome?.storage?.session;
    if (!session) {
      return;
    }
    chrome.storage.onChanged.addListener(this.storageRunProgressListener);
    const stored = await session.get(STORAGE_RUN_PROGRESS_KEY);
    this.storageRunProgress.set(stored[STORAGE_RUN_PROGRESS_KEY] ?? null);
  }

  windowsStayingText({ windowsKeptOpen, untouchedWindowCount }) {
    const total = windowsKeptOpen + untouchedWindowCount;
    const parts = [];
    if (windowsKeptOpen) {
      parts.push(`${windowsKeptOpen} ${windowsKeptOpen === 1 ? 'loses' : 'lose'} some tabs`);
    }
    if (untouchedWindowCount) {
      parts.push(`${untouchedWindowCount} ${untouchedWindowCount === 1 ? "doesn't" : "don't"} change`);
    }
    return `${this.count(total, 'window')} ${total === 1 ? 'stays' : 'stay'} open: ${parts.join(', ')}`;
  }

  storageRunProgressText(progress) {
    const failed = progress.failed ? `, ${progress.failed} failed` : '';
    return `${progress.moved + progress.failed} of ${progress.total} done${failed}. Windows close when it finishes.`;
  }

  storageRunProgressPercent(progress) {
    return progress.total ? ((progress.moved + progress.failed) / progress.total) * 100 : 0;
  }

  async openStoragePanel(mode) {
    if (this.storageRunProgress()) {
      this.flashStatus('Group Hub is still sending to storage. Try again when it finishes.', 'error');
      return;
    }
    try {
      const windowId = await this.targetWindowFor(mode);
      const preview = await this.store.storageRequest('storagePreview', { mode, windowId });
      this.storagePanel.set({ mode, windowId, preview });
    } catch (error) {
      console.error('[GroupHub] storage preview failed', error);
      this.flashStatus('Unable to check which groups would move.', 'error');
    }
  }

  closeStoragePanel() {
    this.storagePanel.set(null);
  }

  async confirmStorageRun() {
    const panel = this.storagePanel();
    if (!panel) {
      return;
    }
    this.storagePanel.set({ ...panel, running: true });
    if (!(await this.savePreRunBackup(panel.preview.incompleteRun))) {
      this.storagePanel.set(null);
      return;
    }
    try {
      const result = await this.store.storageRequest('storageRun', {
        mode: panel.mode,
        windowId: panel.windowId
      });
      if (result?.blocked === 'audible') {
        this.storagePanel.set({ ...panel, preview: { ...panel.preview, audibleTabs: result.audibleTabs } });
      } else if (result) {
        this.storagePanel.set(null);
        this.flashStatus(
          `${this.count(result.movedGroups, 'group')} stored${result.failed ? `, ${result.failed} failed. Send again to retry` : ''}.`,
          result.failed ? 'error' : 'success'
        );
      }
    } catch (error) {
      console.error('[GroupHub] storage run failed', error);
      this.storagePanel.set(null);
      this.flashStatus('The storage run failed. Send again to retry.', 'error');
    }
  }

  async savePreRunBackup(keepExisting) {
    try {
      const handle = await getProfileBackupHandle();
      if (!handle) {
        this.flashStatus('No backup location is available, so nothing was moved.', 'error');
        return false;
      }
      if (keepExisting && (await getBackupStatusForHandle(handle)).preRunBackup) {
        return true;
      }
      const payload = await this.store.exportData();
      await writePreRunBackup(handle, payload);
      await this.copyToChosenFolder((chosen) => writePreRunBackup(chosen, payload));
      await this.loadBackupStatus();
      return true;
    } catch (error) {
      console.error('[GroupHub] backup before storage run failed', error);
      this.flashStatus('The backup failed, so nothing was moved.', 'error');
      return false;
    }
  }

  async goToTab(tab) {
    try {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (error) {
      console.error('[GroupHub] unable to open playing tab', error);
      this.flashStatus('Unable to open that tab.', 'error');
    }
  }

  async popOutGroup(groupId, scope) {
    this.popOutChoice.set(null);
    try {
      await this.store.storageRequest('storagePopOut', { groupId, scope });
      window.close();
    } catch (error) {
      console.error('[GroupHub] pop out failed', error);
      this.flashStatus(this.errorMessage(error, 'Unable to bring that group back.'), 'error');
    }
  }

  closePopOutChoice() {
    this.popOutChoice.set(null);
  }

  expandGroupFully(groupId) {
    if (this.viewMode() === VIEW_MODE.ALL_TABS) {
      const next = new Set(this.collapsedGroups());
      if (next.delete(groupId)) {
        this.collapsedGroups.set(next);
        return;
      }
    }
    const next = new Set(this.expandedGroups());
    next.add(groupId);
    this.expandedGroups.set(next);
  }

  visibleTabsForGroup(entry) {
    const tabs = this.orderedTabs(entry);

    if (!tabs.length) {
      return [];
    }

    const mode = this.viewMode();
    if (mode === VIEW_MODE.ALL_TABS) {
      return this.collapsedGroups().has(entry.group.id) ? tabs.slice(0, 2) : tabs;
    }

    if (this.expandedGroups().has(entry.group.id)) {
      return tabs;
    }

    if (mode === VIEW_MODE.PREVIEW) {
      return tabs.slice(0, 2);
    }

    return [];
  }

  hiddenTabCount(entry) {
    if (this.viewMode() === VIEW_MODE.GROUPS) {
      return 0;
    }
    const total = this.orderedTabs(entry);
    const visible = this.visibleTabsForGroup(entry).length;
    return Math.max(0, total.length - visible);
  }

  toggleHighlightTerm(text) {
    const term = this.searchTerm().trim();
    if (!term) {
      return text;
    }
    const index = text.toLowerCase().indexOf(term.toLowerCase());
    if (index === -1) {
      return text;
    }
    const before = text.slice(0, index);
    const match = text.slice(index, index + term.length);
    const after = text.slice(index + term.length);
    return `${before}<mark>${match}</mark>${after}`;
  }

  colorFor(color) {
    return COLOR_PALETTE[color] ?? COLOR_PALETTE.grey;
  }

  chipStyles(color) {
    const base = this.colorFor(color);
    const { r, g, b } = hexToRgb(base);
    return {
      background: `rgba(${r}, ${g}, ${b}, 0.16)`,
      borderColor: `rgba(${r}, ${g}, ${b}, 0.32)`
    };
  }

  previewTabs(entry) {
    return this.orderedTabs(entry).slice(0, 3);
  }

  isExpanded(groupId) {
    return this.expandedGroups().has(groupId);
  }

  async refresh() {
    await this.store.refresh();
    void this.loadSelectedTabs();
  }

  async triggerExport() {
    try {
      const payload = await this.store.exportData();
      this.saveFile(payload, `tab-groups-${this.timestampForFilename()}.json`);
      this.flashStatus('Export ready.', 'success');
    } catch (error) {
      console.error('[GroupHub] export failed', error);
      this.flashStatus('Export failed. Please try again.', 'error');
    }
  }

  openImport() {
    const input = this.importInput?.nativeElement;
    if (!input) {
      return;
    }
    input.value = '';
    input.click();
  }

  async handleImportSelected(event) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      this.pendingImportPayload.set(payload);
      this.restoreChoice.set('import');
    } catch (error) {
      console.error('[GroupHub] import failed', error);
      this.flashStatus('Import failed. Check the file and retry.', 'error');
    } finally {
      input.value = '';
    }
  }

  openBackupRestore() {
    if (!this.backupCanRestore()) {
      this.flashStatus('No backup is available yet.', 'error');
      return;
    }
    this.restoreChoice.set('backup');
  }

  closeRestoreChoice() {
    this.restoreChoice.set(null);
    this.pendingImportPayload.set(null);
  }

  async runRestoreChoice(mode) {
    const source = this.restoreChoice();
    try {
      let result;
      if (source === 'pre-run') {
        const handle = await getProfileBackupHandle();
        result = await this.store.importData(await readBackupFile(handle, PRE_RUN_BACKUP_FILE_NAME), mode);
        await this.loadBackupStatus();
      } else if (source === 'backup') {
        const payload = await this.readLatestBackupPayload();
        result = await this.store.importData(payload, mode);
        await this.loadBackupStatus();
      } else {
        result = await this.store.importData(this.pendingImportPayload(), mode);
      }
      this.restoreChoice.set(null);
      this.pendingImportPayload.set(null);
      await this.refresh();
      this.flashStatus(this.restoreResultText(result, mode), result?.partial ? 'error' : 'success');
    } catch (error) {
      console.error('[GroupHub] restore failed', error);
      this.flashStatus('Restore failed. Check the backup and retry.', 'error');
    }
  }

  restoreResultText(result, mode) {
    const action = mode === 'replace' ? 'Replaced' : 'Appended';
    const groups = result?.createdGroups ?? 0;
    const tabs = result?.createdTabs ?? 0;
    if (result?.partial) {
      return `${action} ${groups} groups and ${tabs} tabs. Some tabs were skipped.`;
    }
    return `${action} ${groups} groups and ${tabs} tabs.`;
  }

  async loadBackupStatus() {
    try {
      this.backupStatus.set(await this.readBackupStatus());
    } catch (error) {
      console.error('[GroupHub] backup status failed', error);
    }
  }

  toggleBackupPanel() {
    this.backupPanelVisible.update((open) => !open);
  }

  async chooseBackupFolder() {
    if (!('showDirectoryPicker' in window)) {
      this.flashStatus('Backup folders are not supported in this browser.', 'error');
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'documents' });
      const allowed = await this.ensureBackupPermission(handle);
      if (!allowed) {
        this.flashStatus('Backup folder permission was not granted.', 'error');
        return;
      }
      await setBackupDirectoryHandle(handle);
      this.backupStatus.set(await this.writeBackupFromPage({ force: true }));
      this.flashStatus('Backup folder saved. Chrome may ask for permission again after Group Hub closes.', 'success');
    } catch (error) {
      if (error?.name === 'AbortError') {
        return;
      }
      console.error('[GroupHub] choose backup folder failed', error);
      this.flashStatus(this.errorMessage(error, 'Backup setup failed.'), 'error');
    }
  }

  openBackupSetupTab() {
    void chrome.tabs.create({ url: `${location.origin}${location.pathname}?${BACKUP_SETUP_QUERY}` });
  }

  async runBackupNow() {
    try {
      const chosen = await getChosenBackupHandle();
      const allowed = !chosen || (await this.ensureBackupPermission(chosen));
      this.backupStatus.set(await this.writeBackupFromPage({ force: true }));
      this.flashStatus(allowed ? 'Backup saved.' : 'Backup saved in the Chrome profile only.', allowed ? 'success' : 'error');
    } catch (error) {
      console.error('[GroupHub] backup failed', error);
      this.flashStatus(this.errorMessage(error, 'Backup failed.'), 'error');
    }
  }

  async readBackupStatus() {
    const status = await getBackupStatusForHandle(await getProfileBackupHandle(), await this.readBackupSettings());
    const chosen = await getChosenBackupHandle();
    return {
      ...status,
      chosenFolderName: chosen?.name ?? null,
      chosenAllowed: Boolean(await getChosenHandleIfAllowed())
    };
  }

  async copyToChosenFolder(write) {
    try {
      const chosen = await getChosenHandleIfAllowed();
      if (chosen) {
        await write(chosen);
      }
    } catch (error) {
      console.error('[GroupHub] unable to copy backup to chosen folder', error);
    }
  }

  async writeBackupFromPage({ force }) {
    const handle = await getProfileBackupHandle();
    if (!handle) {
      return this.readBackupStatus();
    }
    const payload = await this.store.exportData();
    await writeRotatingBackup(handle, payload, { force });
    await this.copyToChosenFolder((chosen) => writeRotatingBackup(chosen, payload, { force }));
    const status = await this.readBackupStatus();
    const latestBackup = status.latestBackup;
    await this.saveBackupSettings({
      lastBackupAt: latestBackup?.generatedAt ?? null,
      lastBackupDate: latestBackup?.backupDate ?? null,
      lastError: null
    });
    return status;
  }

  async readLatestBackupPayload() {
    const handle = await getProfileBackupHandle();
    const status = await getBackupStatusForHandle(handle, await this.readBackupSettings());
    if (status.permission !== 'granted' || !status.latestBackup) {
      throw new Error('No readable backup is available.');
    }
    return readBackupFile(handle, status.latestBackup.fileName);
  }

  async readBackupSettings() {
    const stored = await chrome.storage.local.get({ [BACKUP_SETTINGS_KEY]: {} });
    return stored[BACKUP_SETTINGS_KEY] ?? {};
  }

  async saveBackupSettings(settings) {
    const existing = await this.readBackupSettings();
    await chrome.storage.local.set({
      [BACKUP_SETTINGS_KEY]: {
        ...existing,
        ...settings,
        updatedAt: Date.now()
      }
    });
  }

  errorMessage(error, fallback) {
    const message = typeof error === 'string' ? error : error?.message;
    if (!message) {
      return fallback;
    }
    return `${fallback} ${message}`;
  }

  async ensureBackupPermission(handle) {
    if (!handle?.queryPermission || !handle?.requestPermission) {
      return false;
    }
    const options = { mode: 'readwrite' };
    if ((await handle.queryPermission(options)) === 'granted') {
      return true;
    }
    return (await handle.requestPermission(options)) === 'granted';
  }

  backupStatusText() {
    const status = this.backupStatus();
    if (!status?.chosenFolderName) {
      return 'Saving in the Chrome profile on this Mac.';
    }
    if (status.chosenAllowed) {
      return `Saving in the Chrome profile and ${status.chosenFolderName}.`;
    }
    return this.openedForBackupSetup
      ? `Saving in the Chrome profile. To also save to ${status.chosenFolderName}, click Backup now and choose "Allow on every visit".`
      : `Saving in the Chrome profile. To also save to ${status.chosenFolderName}, click Open in a tab, as Chrome only offers lasting access there.`;
  }

  backupLastText() {
    const latestBackup = this.backupStatus()?.latestBackup;
    if (!latestBackup) {
      return 'No backups written yet.';
    }
    return `Last backup: ${this.formatTimestamp(latestBackup.generatedAt)} · ${latestBackup.groupCount} groups · ${latestBackup.tabCount} tabs`;
  }

  formatTimestamp(value) {
    try {
      return this.dateFormatter.format(new Date(value));
    } catch {
      return 'Unknown';
    }
  }

  groupToggleLabel(groupId) {
    if (this.viewMode() === VIEW_MODE.ALL_TABS) {
      return this.collapsedGroups().has(groupId) ? 'Expand' : 'Collapse';
    }
    return this.expandedGroups().has(groupId) ? 'Collapse' : 'Expand';
  }

  infoSummary() {
    return `Showing ${this.visibleGroupCount()} of ${this.totalGroups()} groups · ${this.totalVisibleTabs()} tabs`;
  }
  toggleUtilityMenu() {
    this.utilityMenuVisible.update((open) => !open);
  }

  utilityMenuOpen() {
    return this.utilityMenuVisible();
  }

  async loadSelectedTabs() {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query || !chrome.windows?.getLastFocused) {
      this.selectedTabIds.set([]);
      return;
    }
    try {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      const tabs = await chrome.tabs.query({ windowId: win.id, highlighted: true });
      const ids = tabs
        .map((tab) => tab.id)
        .filter((id) => Number.isFinite(id));
      this.selectedTabIds.set(ids);
    } catch (error) {
      console.debug('[GroupHub] unable to load selected tabs', error);
      this.selectedTabIds.set([]);
    }
  }

  hasSelection() {
    return this.selectionCount() > 0;
  }

  selectionAlreadyInGroup(entry) {
    if (!this.hasSelection()) {
      return true;
    }
    const targetTabs = new Set((entry.group.tabs ?? []).map((tab) => tab.id));
    const selection = this.selectedTabIds();
    if (!selection.length) {
      return true;
    }
    for (const id of selection) {
      if (!targetTabs.has(id)) {
        return false;
      }
    }
    return true;
  }

  async moveSelectionToGroup(groupId, event) {
    if (event?.stopPropagation) {
      event.stopPropagation();
      event.preventDefault();
    }
    if (!this.hasSelection()) {
      this.flashStatus('Select one or more tabs in Chrome first.', 'error');
      return;
    }
    const tabIds = this.selectedTabIds();

    // Get previous assignments before moving to ensure we can save the action
    const previousAssignments = [];
    for (const id of tabIds) {
      try {
        const tab = await chrome.tabs.get(id);
        previousAssignments.push({
          tabId: id,
          previousGroupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
          previousWindowId: tab.windowId
        });
      } catch (error) {
        console.warn('[GroupHub] unable to inspect tab before move', id, error);
      }
    }

    if (!previousAssignments.length) {
      this.flashStatus('Unable to access selected tabs.', 'error');
      return;
    }

    // Save the action BEFORE moving tabs (in case popup closes)
    const action = {
      assignments: previousAssignments,
      movedTabIds: tabIds,
      targetGroupId: groupId
    };
    this.lastMoveAction.set(action);
    // Don't await - let it save in background
    this.store.saveLastMoveAction(action).catch(error => {
      console.error('[GroupHub] failed to save move action', error);
    });

    try {
      const result = await this.store.moveTabsToGroup(groupId, tabIds);
      if (result?.movedTabIds?.length) {
        const count = result.movedTabIds.length;
        this.flashStatus(`Moved ${count} tab${count === 1 ? '' : 's'} to the group.`, 'success');
      } else {
        this.flashStatus('No tabs were moved.', 'error');
      }
    } catch (error) {
      console.error('[GroupHub] move tabs failed', error);
      this.flashStatus('Unable to move tabs into the group.', 'error');
    } finally {
      void this.loadSelectedTabs();
    }
  }

  undoAvailable() {
    return !!this.lastMoveAction();
  }

  async undoLastMove() {
    const action = this.lastMoveAction();
    if (!action) {
      return;
    }
    try {
      await this.store.restoreTabs(action.assignments);
      this.flashStatus('Move undone.', 'success');
      this.lastMoveAction.set(null);
      await this.store.clearLastMoveAction();
      void this.loadSelectedTabs();
    } catch (error) {
      console.error('[GroupHub] undo move failed', error);
      this.flashStatus('Unable to undo the move.', 'error');
    }
  }

  async loadLastMoveAction() {
    try {
      const action = await this.store.loadLastMoveAction();
      this.lastMoveAction.set(action);
    } catch (error) {
      console.error('[GroupHub] failed to load last move action', error);
      this.lastMoveAction.set(null);
    }
  }

  getGroupName(groupId) {
    const snapshot = this.snapshot();
    if (!snapshot?.groups) return null;
    const group = snapshot.groups.find(g => g.id === groupId);
    return group?.title || null;
  }

  orderedTabs(entry) {
    const groupTabs = entry?.group?.tabs ?? [];
    if (!this.searchActive()) {
      return groupTabs;
    }
    const matching = entry?.matchingTabs ?? [];
    if (!matching.length) {
      return groupTabs;
    }
    const seen = new Set(matching);
    const remainder = groupTabs.filter((tab) => !seen.has(tab));
    return [...matching, ...remainder];
  }

  computeFilteredGroups() {
    const snapshot = this.snapshot();
    if (!snapshot) {
      return [];
    }

    const searchTermRaw = this.searchTerm().trim();
    const searchTerm = searchTermRaw.toLowerCase();
    const hasSearch = searchTerm.length > 0;

    if (!hasSearch) {
      const entries = snapshot.groups.map((group) => ({
        group,
        groupMatches: true,
        matchingTabs: []
      }));
      return this.sortEntries(entries, this.sortMode());
    }

    const titleMatches = [];
    const tabMatches = [];

    for (const group of snapshot.groups) {
      const titleMatch = (group.title ?? '').toLowerCase().includes(searchTerm);
      const matchingTabs = group.tabs.filter((tab) => {
        const title = (tab.title ?? '').toLowerCase();
        const url = (tab.url ?? '').toLowerCase();
        return title.includes(searchTerm) || url.includes(searchTerm);
      });

      if (titleMatch) {
        titleMatches.push({
          group,
          groupMatches: true,
          matchingTabs
        });
      } else if (matchingTabs.length > 0) {
        tabMatches.push({
          group,
          groupMatches: false,
          matchingTabs
        });
      }
    }

    const mode = this.sortMode();
    return [
      ...this.sortEntries(titleMatches, mode),
      ...this.sortEntries(tabMatches, mode)
    ];
  }

  sortEntries(entries, mode) {
    const sorted = [...entries];
    switch (mode) {
      case 'name-desc':
        sorted.sort((a, b) => {
          const aTitle = (a.group.title ?? '').toLowerCase();
          const bTitle = (b.group.title ?? '').toLowerCase();
          if (aTitle === bTitle) {
            return b.group.id - a.group.id;
          }
          return bTitle.localeCompare(aTitle);
        });
        break;
      case 'created-asc':
        sorted.sort((a, b) => (a.group.createdAt ?? 0) - (b.group.createdAt ?? 0));
        break;
      case 'created-desc':
        sorted.sort((a, b) => (b.group.createdAt ?? 0) - (a.group.createdAt ?? 0));
        break;
      case 'name-asc':
      default:
        sorted.sort((a, b) => {
          const aTitle = (a.group.title ?? '').toLowerCase();
          const bTitle = (b.group.title ?? '').toLowerCase();
          if (aTitle === bTitle) {
            return a.group.id - b.group.id;
          }
          return aTitle.localeCompare(bTitle);
        });
        break;
    }
    return sorted;
  }

  saveFile(payload, fileName) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  timestampForFilename() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  flashStatus(text, tone) {
    this.statusMessage.set({ text, tone });
    if (this.statusTimeout !== undefined) {
      clearTimeout(this.statusTimeout);
    }
    this.statusTimeout = window.setTimeout(() => {
      this.statusMessage.set(null);
      this.statusTimeout = undefined;
    }, 4000);
  }
}

function hexToRgb(hex) {
  const raw = hex.replace('#', '');
  const value = raw.length === 3
    ? raw.split('').map((char) => char + char).join('')
    : raw.padStart(6, '0');
  const num = parseInt(value, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return { r, g, b };
}
