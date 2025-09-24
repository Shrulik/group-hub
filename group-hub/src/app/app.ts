// @ts-nocheck
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App implements OnInit {
  store = inject(GroupHubStore);

  searchTerm = signal('');
  sortMode = signal('name-asc');
  viewMode = signal(VIEW_MODE.GROUPS);
  expandedGroups = signal(new Set());
  collapsedGroups = signal(new Set());
  statusMessage = signal(null);
  utilityMenuVisible = signal(false);

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

  @ViewChild('importInput') importInput;

  statusTimeout;
  dateFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  async ngOnInit() {
    try {
      await this.store.init();
    } catch (error) {
      console.error('[GroupHub] initialization failed', error);
      this.flashStatus('Chrome extension APIs unavailable.', 'error');
    }
  }

  trackGroup = (_index, entry) => entry.group.id;
  trackTab = (_index, tab) => tab.id;

  onSearchChange(term) {
    this.searchTerm.set(term);
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
      await this.store.openGroup(groupId);
      try {
        window.close();
      } catch (closeError) {
        console.debug('[GroupHub] unable to close popover window', closeError);
      }
    } catch (error) {
      console.error('[GroupHub] activate group failed', error);
      this.flashStatus('Unable to open the group. It may no longer exist.', 'error');
    }
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
      await this.store.importData(payload);
      this.flashStatus('Import completed.', 'success');
    } catch (error) {
      console.error('[GroupHub] import failed', error);
      this.flashStatus('Import failed. Check the file and retry.', 'error');
    } finally {
      input.value = '';
    }
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
