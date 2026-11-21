'use strict';

// A fake SillyTavern context for the lease's ST hooks (spec E4, E10): characters, the open chat,
// the connection, an event source with ST's auto-fired APP_READY, and records of the calls the lease
// makes. Invented data only.

const EVENT_TYPES = Object.freeze({
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    ONLINE_STATUS_CHANGED: 'online_status_changed',
});

/** An event source like ST's: APP_READY fires again for a listener added after it fired. */
function createEventSource() {
    const listeners = new Map();
    const fired = new Map();
    return {
        on(event, fn) {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(fn);
            if (event === EVENT_TYPES.APP_READY && fired.has(event)) fn(...fired.get(event));
        },
        removeListener(event, fn) {
            const list = listeners.get(event) || [];
            const index = list.indexOf(fn);
            if (index !== -1) list.splice(index, 1);
        },
        emit(event, ...args) {
            if (event === EVENT_TYPES.APP_READY) fired.set(event, args);
            for (const fn of [...(listeners.get(event) || [])]) fn(...args);
        },
        count: (event) => (listeners.get(event) || []).length,
    };
}

/**
 * ST's state and the context functions the lease calls.
 * @param {object} [options]
 * @param {object[]} [options.characters] Characters (`avatar`, `chat`).
 * @param {number} [options.characterId] The selected character's index.
 * @param {string|null} [options.groupId] The selected group.
 * @param {string} [options.groupChat] The selected group's chat.
 * @param {string} [options.onlineStatus] ST's `onlineStatus`.
 * @param {string} [options.mainApi] ST's `main_api`.
 * @param {boolean} [options.selectFails] selectCharacterById changes nothing (a save or reply running).
 * @returns {object} The fake ST.
 */
function createFakeSt({
    characters = [
        { avatar: 'Example Character.png', chat: 'Example Chat - 1' },
        { avatar: 'Other Character.png', chat: 'Other Chat' },
    ],
    characterId,
    groupId = null,
    groupChat = 'Example Group Chat',
    onlineStatus = 'no_connection',
    mainApi = 'openai',
    selectFails = false,
} = {}) {
    const st = {
        characters,
        characterId,
        groupId,
        onlineStatus,
        mainApi,
        calls: [],
        eventSource: createEventSource(),
    };
    st.getContext = () => ({
        characters: st.characters,
        groups: [],
        characterId: st.characterId,
        groupId: st.groupId,
        chatId: st.groupId ? groupChat : (st.characters[st.characterId] || {}).chat,
        onlineStatus: st.onlineStatus,
        mainApi: st.mainApi,
        eventSource: st.eventSource,
        eventTypes: EVENT_TYPES,
        selectCharacterById: async (id) => {
            st.calls.push(['selectCharacterById', id]);
            if (selectFails) return;
            st.groupId = null;
            st.characterId = id;
            st.eventSource.emit(EVENT_TYPES.CHAT_CHANGED, st.characters[id].chat);
        },
        openCharacterChat: async (file) => {
            st.calls.push(['openCharacterChat', file]);
            st.characters[st.characterId].chat = file;
            st.eventSource.emit(EVENT_TYPES.CHAT_CHANGED, file);
        },
    });
    /** ST's status changes (setOnlineStatus). */
    st.setOnlineStatus = (value) => {
        const changed = value !== st.onlineStatus;
        st.onlineStatus = value;
        if (changed) st.eventSource.emit(EVENT_TYPES.ONLINE_STATUS_CHANGED, value);
    };
    return st;
}

/** Fake timers: nothing runs until `runAll()`. */
function createFakeTimers() {
    const timers = new Map();
    let next = 1;
    return {
        setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
        clearTimeout: (id) => { timers.delete(id); },
        pending: () => [...timers.values()].map((t) => t.ms),
        runAll: () => {
            const due = [...timers.values()];
            timers.clear();
            for (const t of due) t.fn();
        },
    };
}

module.exports = { EVENT_TYPES, createEventSource, createFakeSt, createFakeTimers };
