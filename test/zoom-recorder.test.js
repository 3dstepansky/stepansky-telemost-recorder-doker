import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZoomRecorder,
  inspectZoomUiState,
  isZoomMeetingJoined,
  isZoomWaitingRoom,
  isZoomExplicitlyEnded,
  zoomStopFileName,
  selectZoomNameInput,
} from '../recorders/zoom.js';

test('selectZoomNameInput supports current Zoom input-for-name selector', () => {
  const selectors = [];
  const document = {
    querySelector(selector) {
      selectors.push(selector);
      return selector === '#input-for-name' ? { id: 'input-for-name' } : null;
    },
  };

  const input = selectZoomNameInput(document);
  assert.equal(input.id, 'input-for-name');
  assert.equal(selectors[0], '#input-for-name');
});

test('prejoin form is not considered a joined Zoom meeting', () => {
  const state = inspectZoomUiState({
    url: 'https://app.zoom.us/wc/123/join',
    bodyText: 'Your Name Remember my name Join',
    buttons: ['Mute', 'Stop Video', 'Join'],
    hasNameInput: true,
  });
  assert.equal(isZoomMeetingJoined(state), false);
  assert.equal(isZoomWaitingRoom(state), false);
});

test('meeting controls and participant list confirm a joined Zoom meeting', () => {
  const state = inspectZoomUiState({
    url: 'https://app.zoom.us/wc/123/join',
    bodyText: 'Audio Video 2 Participants Chat React More Leave Telemost Assistant Pavel',
    buttons: ['Audio', 'Video', 'Participants', 'Chat', 'Leave'],
    hasNameInput: false,
  });
  assert.equal(isZoomMeetingJoined(state), true);
});

test('transient audio dialog still counts as joined when Leave and Participants remain', () => {
  const state = inspectZoomUiState({
    url: 'https://app.zoom.us/wc/123/join',
    bodyText: 'Cannot detect your microphone Audio 2 Participants Leave',
    buttons: ['Audio', 'Participants', 'Leave'],
    hasNameInput: false,
  });
  assert.equal(isZoomMeetingJoined(state), true);
});

test('waiting room is detected but not considered joined', () => {
  const state = inspectZoomUiState({
    url: 'https://app.zoom.us/wc/123/join',
    bodyText: 'Please wait, the meeting host will let you in soon',
    buttons: [],
    hasNameInput: false,
  });
  assert.equal(isZoomWaitingRoom(state), true);
  assert.equal(isZoomMeetingJoined(state), false);
});

test('temporary missing toolbar is not an explicit meeting end', () => {
  const state = inspectZoomUiState({
    url: 'https://app.zoom.us/wc/123/join',
    bodyText: 'Cannot detect your microphone',
    buttons: [],
    hasNameInput: false,
  });
  assert.equal(isZoomExplicitlyEnded(state), false);
});

test('removed-from-meeting screen is an explicit end', () => {
  const state = inspectZoomUiState({ bodyText: 'You have been removed from the meeting' });
  assert.equal(isZoomExplicitlyEnded(state), true);
});

test('Zoom stop-file name matches Telegram callback meeting id', () => {
  assert.equal(zoomStopFileName('https://us04web.zoom.us/j/71281226852?pwd=secret'), 'stop_71281226852');
});

test('ZoomRecorder exposes a lifecycle monitor for active recordings', () => {
  assert.equal(typeof ZoomRecorder.prototype.startMonitor, 'function');
});

test('ZoomRecorder overrides stop so it can leave the Zoom room before closing', () => {
  assert.equal(Object.hasOwn(ZoomRecorder.prototype, 'stop'), true);
});
