// @ts-nocheck
import { TestBed } from '@angular/core/testing';
import { App } from './app';

// Mock Chrome APIs
(globalThis as any).chrome = {
  storage: {
    local: {
      get: jasmine.createSpy('chrome.storage.local.get').and.returnValue(Promise.resolve({})),
      set: jasmine.createSpy('chrome.storage.local.set').and.returnValue(Promise.resolve()),
      remove: jasmine.createSpy('chrome.storage.local.remove').and.returnValue(Promise.resolve())
    },
    onChanged: {
      addListener: jasmine.createSpy('chrome.storage.onChanged.addListener'),
      removeListener: jasmine.createSpy('chrome.storage.onChanged.removeListener')
    }
  },
  runtime: {
    sendMessage: jasmine.createSpy('chrome.runtime.sendMessage').and.returnValue(Promise.resolve({})),
    onMessage: {
      addListener: jasmine.createSpy('chrome.runtime.onMessage.addListener'),
      removeListener: jasmine.createSpy('chrome.runtime.onMessage.removeListener')
    }
  },
  tabs: {
    query: jasmine.createSpy('chrome.tabs.query').and.returnValue(Promise.resolve([])),
    group: jasmine.createSpy('chrome.tabs.group').and.returnValue(Promise.resolve(1)),
    ungroup: jasmine.createSpy('chrome.tabs.ungroup').and.returnValue(Promise.resolve()),
    get: jasmine.createSpy('chrome.tabs.get').and.returnValue(Promise.resolve({ id: 1, groupId: -1 }))
  },
  windows: {
    getLastFocused: jasmine.createSpy('chrome.windows.getLastFocused').and.returnValue(Promise.resolve({ id: 1, type: 'normal' }))
  },
  tabGroups: {
    query: jasmine.createSpy('chrome.tabGroups.query').and.returnValue(Promise.resolve([])),
    update: jasmine.createSpy('chrome.tabGroups.update').and.returnValue(Promise.resolve({}))
  }
};

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render search input', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.toolbar__search')?.getAttribute('placeholder')).toContain('Search groups or tabs');
  });
});
