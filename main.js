'use strict';
const electron = require('electron');
const app = electron.app;
const fs = require('fs');
const path_mod = require('path');

var isbound = false; /* true if we're a single-game app */
var gamewins = {}; /* maps window ID to a game structure */
var aboutwin = null; /* the splash/about window, if active */
var cardwin = null; /* the postcard window, if active */
var prefswin = null; /* the preferences window, if active */
var gamedialog = false; /* track whether the game-open dialog is visible */

var prefs = {
    gamewin_width: 600,
    gamewin_height: 800,
    gamewin_marginlevel: 1,
    gamewin_colortheme: 'light',
    gamewin_font: 'lora',
    gamewin_zoomlevel: 0
};
var prefspath = path_mod.join(app.getPath('userData'), 'lectrote-prefs.json');
var prefstimer = null;
var prefswriting = false;

var app_ready = false; /* true once the ready event occurred */
var launch_paths = []; /* game files passed in before app_ready */
var aboutwin_initial = false; /* true if the aboutwin was auto-opened */

function game_for_window(win)
{
    if (!win)
        return undefined;
    return gamewins[win.id];
}

function game_for_webcontents(webcontents)
{
    if (!webcontents)
        return undefined;
    for (var id in gamewins) {
        var game = gamewins[id];
        if (game.win && game.win.webContents === webcontents)
            return game;
    }    
    return undefined;
}

function construct_recent_game_menu()
{
    var res = [];

    if (isbound)
        return res;

    /* This requires a utility function because of Javascript's lousy 
       closures. */
    var add = function(path) {
        var opts = {
            label: path_mod.basename(path),
            click: function() {
                launch_game(path);
            }
        };
        res.push(opts);
    };
    
    var recents = prefs.recent_games;
    if (recents && recents.length) {
        for (var ix=0; ix<recents.length; ix++) {
            add(recents[ix]);
        }
    }

    return res;
}

/* Add a game to the recently-opened list. Note that this does *not* affect
   the "File / Open Recent" submenu! This is an Electron limitation:
       https://github.com/atom/electron/issues/527
   The submenu will be filled in next time the app launches.
*/
function add_recent_game(path)
{
    /* The system recent list is easy -- it handles its own ordering
       and uniqueness. This list shows up on the Dock icon on MacOS. */
    app.addRecentDocument(path);

    var recents = prefs.recent_games;
    if (recents === undefined) {
        recents = [];
        prefs.recent_games = recents;
    }

    /* Remove any duplicate so we can move this game to the top. */
    for (var ix=0; ix<recents.length; ix++) {
        if (recents[ix] == path) {
            recents.splice(ix, 1);
            break;
        }
    }

    /* Push onto beginning. */
    recents.unshift(path);

    /* Keep no more than 8. */
    if (recents.length > 8)
        recents.length = 8;

    note_prefs_dirty();
}

/* If you create two windows in a row, the second should be offset. But
   if you create a window, close it, and create a new window, the second
   should not be offset. Sorry, it's messy to describe and messy to
   implement.
   The effect is to pick the lowest offset value not used by any window.
*/
function pick_window_offset()
{
    /* Create a list of all offsets currently in use. */
    var offsets = [];
    for (var id in gamewins) {
        var offset = gamewins[id].offset;
        if (offset !== undefined)
            offsets[offset] = true;
    }

    for (var ix=0; true; ix++) {
        if (!offsets[ix])
            return ix;
    }
}

function clear_window_offsets()
{
    for (var id in gamewins) {
        delete gamewins[id].offset;
    }
}

/* Called only at app startup. */
function load_prefs()
{
    try {
        var prefsstr = fs.readFileSync(prefspath, { encoding:'utf8' });
        var obj = JSON.parse(prefsstr);
        for (var key in obj) {
            prefs[key] = obj[key];
        }
    }
    catch (ex) {
        console.error('load_prefs: unable to load preferences: %s: %s', prefspath, ex);
    }

    /* Check to make sure the recent files still exist. */
    var recents = prefs.recent_games;
    if (recents && recents.length) {
        var ls = [];
        for (var ix=0; ix<recents.length; ix++) {
            try {
                fs.accessSync(recents[ix], fs.R_OK);
                ls.push(recents[ix]);
            }
            catch (ex) {}
        }
        if (ls.length < recents.length) {
            prefs.recent_games = ls;
            note_prefs_dirty();
        }
    }
}

/* We can't rely on the web-frame algorithm for this, because we have
   to include it when creating the browser window. So we have our
   own bit of code: basically 10% larger/smaller per unit.
*/
function zoom_factor_for_level(val)
{
    if (!val)
        return 1;
    return Math.exp(val * 0.09531017980432493);
}

/* Called whenever we update the prefs object. This waits five seconds 
   (to consolidate writes) and then launches an async file-write.
*/
function note_prefs_dirty()
{
    /* If a timer is in flight, we're covered. */
    if (prefstimer !== null)
        return;
    prefstimer = setTimeout(handle_write_prefs, 5000);
}

/* Callback for prefs-dirty timer. */
function handle_write_prefs()
{
    prefstimer = null;
    /* If prefswriting is true, a writeFile call is in flight. Yes, this
       is an annoying corner case. We have new data to write but we have
       to wait for the writeFile to finish. We do this by punting for
       another five seconds! */
    if (prefswriting) {
        note_prefs_dirty();
        return;
    }

    prefswriting = true;
    var prefsstr = JSON.stringify(prefs);
    fs.writeFile(prefspath, prefsstr, { encoding:'utf8' }, function(err) {
            prefswriting = false;
        });
}

/* Called when the app is shutting down. Write out the prefs if they're dirty.
*/
function write_prefs_now()
{
    if (prefstimer !== null) {
        clearTimeout(prefstimer);
        prefstimer = null;
        var prefsstr = JSON.stringify(prefs);
        fs.writeFileSync(prefspath, prefsstr, { encoding:'utf8' });
    }
}

/* Call one of the functions in apphooks.js (in the game renderer process).
   The argument is passed as a JSON string.
*/
function invoke_app_hook(win, func, arg)
{
    win.webContents.send(func, arg);
}

/* Bring up the select-a-game dialog. 
*/
function select_load_game()
{
    if (isbound) {
        /* We're in bound-game mode and shouldn't be opening any other
           games. */
        return;
    }

    if (gamedialog) {
        /* The dialog is already up. I'd focus it if I had a way to do that,
           but I don't. */
        return;
    }

    var opts = {
        title: 'Select a Glulx game file',
        properties: ['openFile'],
        filters: [ { name: 'Glulx Game File', extensions: ['ulx', 'blorb', 'blb', 'gblorb', 'glb'] } ]
    };

    gamedialog = true;
    electron.dialog.showOpenDialog(null, opts, function(ls) {
        gamedialog = false;
        if (!ls || !ls.length)
            return;
        launch_game(ls[0]);
    });
}

/* Open a game window for a given game file.
*/
function launch_game(path)
{
    /* Make sure the file is readable before we pass it over to the
       renderer window. */
    try {
        fs.accessSync(path, fs.R_OK);
    }
    catch (ex) {
        electron.dialog.showErrorBox('The game file could not be read.', ''+ex);
        return;
    }

    if (aboutwin && aboutwin_initial) {
        /* Dispose of the (temporary) splash window. This needs a time delay
           for some annoying internal reason. */
        setTimeout( function() { if (aboutwin) aboutwin.close(); }, 50);
    }

    add_recent_game(path);

    var win = null;
    var game = {
        path: path,
        title: null,
        signature: null
    };

    var winopts = {
        title: require('electron').app.getName(),
        width: prefs.gamewin_width, height: prefs.gamewin_height,
        minWidth: 400, minHeight: 400,
        zoomFactor: zoom_factor_for_level(prefs.gamewin_zoomlevel)
    };

    if (process.platform == 'win32') {
        winopts.icon = path_mod.join(__dirname, 'docicon.ico');
    }

    /* BUG: The offsetting only applies if you have a window location
       preference. For a brand-new user this will not be true. */
    var offset = pick_window_offset();
    if (prefs.gamewin_x !== undefined)
        winopts.x = prefs.gamewin_x + 20 * offset;
    if (prefs.gamewin_y !== undefined)
        winopts.y = prefs.gamewin_y + 20 * offset;

    win = new electron.BrowserWindow(winopts);
    if (!win)
        return;

    game.win = win;
    game.id = win.id;
    game.offset = offset;
    gamewins[game.id] = game;

    if (process.platform == 'darwin') {
        win.setRepresentedFilename(game.path);
    }

    /* Game window callbacks */

    win.on('closed', function() {
        delete gamewins[game.id];
        game = null;
        win = null;
    });

    win.webContents.on('dom-ready', function(ev) {
        var game = game_for_webcontents(ev.sender);
        if (!game)
            return;
        invoke_app_hook(win, 'set_margin_level', prefs.gamewin_marginlevel);
        invoke_app_hook(win, 'set_color_theme', prefs.gamewin_colortheme);
        invoke_app_hook(win, 'set_font', prefs.gamewin_font);
        if (game.suppress_autorestore) {
            invoke_app_hook(win, 'set_clear_autosave', true);
            game.suppress_autorestore = false;
        }
        invoke_app_hook(win, 'load_named_game', game.path);
    });

    win.on('resize', function() {
        prefs.gamewin_width = win.getSize()[0];
        prefs.gamewin_height = win.getSize()[1];
        note_prefs_dirty();
    });
    win.on('move', function() {
        prefs.gamewin_x = win.getPosition()[0];
        prefs.gamewin_y = win.getPosition()[1];
        note_prefs_dirty();

        /* We're starting with a new position, so erase the history of
           what windows go here. */
        clear_window_offsets();
        var game = game_for_window(win);
        if (game)
            game.offset = 0;
    });

    /* Load the game UI and go. */
    win.loadURL('file://' + __dirname + '/play.html');
}

function reset_game(game)
{
    if (!game.win)
        return;

    var winopts = {
        type: 'question',
        message: 'Are you sure you want to reset the game to the beginning? This will discard all your progress since your last SAVE command.',
        buttons: ['Reset', 'Cancel'],
        cancelId: 0
    };
    /* We use a synchronous showMessageBox call, which blocks (is modal for)
       the entire app. The async call would only block the game window, but
       that causes weird results (e.g., cmd-Q fails to shut down the blocked
       game window). */
    var res = electron.dialog.showMessageBox(game.win, winopts);
    if (res == winopts.cancelId) {
        var win = game.win;
        /* Set a flag to inhibit autorestore (but not autosave). This
           will be cleared when the page finishes loading. */
        game.suppress_autorestore = true;
        /* Load the game UI and go. */
        win.loadURL('file://' + __dirname + '/play.html');
    }
}

function open_about_window()
{
    var winopts = { 
        width: 600, height: 400,
        useContentSize: true,
        resizable: false
    };
    if (prefs.aboutwin_x !== undefined)
        winopts.x = prefs.aboutwin_x;
    if (prefs.aboutwin_y !== undefined)
        winopts.y = prefs.aboutwin_y;

    aboutwin = new electron.BrowserWindow(winopts);

    if (process.platform != 'darwin') {
        var template = construct_menu_template('about');
        var menu = electron.Menu.buildFromTemplate(template);
        aboutwin.setMenu(menu);
    }
    
    aboutwin.on('closed', function() {
            aboutwin = null;
        });
    aboutwin.on('move', function() {
            prefs.aboutwin_x = aboutwin.getPosition()[0];
            prefs.aboutwin_y = aboutwin.getPosition()[1];
            note_prefs_dirty();
        });
    aboutwin.webContents.on('will-navigate', function(ev, url) {
            require('electron').shell.openExternal(url);
            ev.preventDefault();
        });

    aboutwin.webContents.on('dom-ready', function() {
            var ls = construct_recent_game_menu();
            aboutwin.webContents.send('recent-count', ls.length);
        });

    aboutwin.loadURL('file://' + __dirname + '/about.html');
}

function open_prefs_window()
{
    var winopts = { 
        width: 600, height: 500,
        useContentSize: true,
        resizable: false
    };
    if (prefs.prefswin_x !== undefined)
        winopts.x = prefs.prefswin_x;
    if (prefs.prefswin_y !== undefined)
        winopts.y = prefs.prefswin_y;

    prefswin = new electron.BrowserWindow(winopts);

    if (process.platform != 'darwin') {
        var template = construct_menu_template('prefs');
        var menu = electron.Menu.buildFromTemplate(template);
        prefswin.setMenu(menu);
    }
    
    prefswin.on('closed', function() {
            prefswin = null;
        });
    prefswin.on('move', function() {
            prefs.prefswin_x = prefswin.getPosition()[0];
            prefs.prefswin_y = prefswin.getPosition()[1];
            note_prefs_dirty();
        });

    prefswin.webContents.on('dom-ready', function() {
            prefswin.webContents.send('current-prefs', prefs);
        });

    prefswin.loadURL('file://' + __dirname + '/prefs.html');
}

function open_card_window()
{
    var winopts = { 
        width: 810, height: 600,
        maxWidth: 810, maxHeight: 600,
        useContentSize: true,
        javascript: false
    };
    if (prefs.cardwin_x !== undefined)
        winopts.x = prefs.cardwin_x;
    if (prefs.cardwin_y !== undefined)
        winopts.y = prefs.cardwin_y;

    cardwin = new electron.BrowserWindow(winopts);

    if (process.platform != 'darwin') {
        var template = construct_menu_template('card');
        var menu = electron.Menu.buildFromTemplate(template);
        cardwin.setMenu(menu);
    }
    
    cardwin.on('closed', function() {
            cardwin = null;
        });
    cardwin.on('move', function() {
            prefs.cardwin_x = cardwin.getPosition()[0];
            prefs.cardwin_y = cardwin.getPosition()[1];
            note_prefs_dirty();
        });
    cardwin.webContents.on('will-navigate', function(ev, url) {
            require('electron').shell.openExternal(url);
            ev.preventDefault();
        });

    cardwin.loadURL('file://' + __dirname + '/if-card.html');
}

function find_in_template(template, key)
{
    for (var ix=0; ix<template.length; ix++) {
        var stanza = template[ix];
        if (stanza.label == key)
            return stanza;
    }
    return null;
};

function index_in_template(template, key)
{
    for (var ix=0; ix<template.length; ix++) {
        var stanza = template[ix];
        if (stanza.label == key)
            return ix;
    }
    return -1;
};

function construct_menu_template(special)
{
    var name = require('electron').app.getName();

    var template = [
    {
        label: 'File',
        submenu: [
        {
            label: 'Open Game...',
            accelerator: 'CmdOrCtrl+O',
            click: function() {
                select_load_game();
            }
        },
        {
            label: 'Open Recent',
            type: 'submenu',
            submenu: construct_recent_game_menu()
        },
        { type: 'separator' },
        {
            label: 'Reset Game...',
            accelerator: 'CmdOrCtrl+R',
            click: function(item, win) {
                var game = game_for_window(win);
                if (!game)
                    return;
                reset_game(game);
            }
        },
        { type: 'separator' },
        {
            label: 'Close Window',
            accelerator: 'CmdOrCtrl+W',
            role: 'close'
        }
        ]
    },
    {
        label: 'Edit',
        submenu: [
        {
            label: 'Cut',
            accelerator: 'CmdOrCtrl+X',
            enabled: (!special),
            role: 'cut'
        },
        {
            label: 'Copy',
            accelerator: 'CmdOrCtrl+C',
            role: 'copy'
        },
        {
            label: 'Paste',
            accelerator: 'CmdOrCtrl+V',
            enabled: (!special),
            role: 'paste'
        },
        {
            label: 'Select All',
            accelerator: 'CmdOrCtrl+A',
            role: 'selectall'
        },
        { type: 'separator' },
        {
            label: 'Preferences',
            accelerator: 'CmdOrCtrl+,',
            enabled: (special != 'prefs'),
            click: function() {
                if (!prefswin)
                    open_prefs_window();
                else
                    prefswin.show();
            }
        }
        ]
    },
    {
        label: 'View',
        submenu: [
        {
            label: 'Zoom In',
            accelerator: 'CmdOrCtrl+=',
            click: function(item, win) {
                prefs.gamewin_zoomlevel += 1;
                if (prefs.gamewin_zoomlevel > 6)
                    prefs.gamewin_zoomlevel = 6;
                note_prefs_dirty();
                var val = zoom_factor_for_level(prefs.gamewin_zoomlevel);
                for (var id in gamewins) {
                    var game = gamewins[id];
                    invoke_app_hook(game.win, 'set_zoom_factor', val);
                }
                if (prefswin)
                    prefswin.webContents.send('set-zoom-level', prefs.gamewin_zoomlevel);
            }
        },
        {
            label: 'Zoom Normal',
            accelerator: 'CmdOrCtrl+0',
            click: function(item, win) {
                prefs.gamewin_zoomlevel = 0;
                note_prefs_dirty();
                var val = zoom_factor_for_level(prefs.gamewin_zoomlevel);
                for (var id in gamewins) {
                    var game = gamewins[id];
                    invoke_app_hook(game.win, 'set_zoom_factor', val);
                }
                if (prefswin)
                    prefswin.webContents.send('set-zoom-level', prefs.gamewin_zoomlevel);
            }
        },
        {
            label: 'Zoom Out',
            accelerator: 'CmdOrCtrl+-',
            click: function(item, win) {
                prefs.gamewin_zoomlevel -= 1;
                if (prefs.gamewin_zoomlevel < -6)
                    prefs.gamewin_zoomlevel = -6;
                note_prefs_dirty();
                var val = zoom_factor_for_level(prefs.gamewin_zoomlevel);
                for (var id in gamewins) {
                    var game = gamewins[id];
                    invoke_app_hook(game.win, 'set_zoom_factor', val);
                }
                if (prefswin)
                    prefswin.webContents.send('set-zoom-level', prefs.gamewin_zoomlevel);
            }
        }
        ]
    },
    {
        label: 'Window',
        role: 'window',
        submenu: [
        {
            label: 'Minimize',
            accelerator: 'CmdOrCtrl+M',
            role: 'minimize'
        },
        {
            label: 'Toggle Developer Tools',
            accelerator: (function() {
                if (process.platform == 'darwin')
                    return 'Alt+Command+I';
                else
                    return 'Ctrl+Shift+I';
            })(),
            click: function(item, focusedWindow) {
                if (focusedWindow)
                    focusedWindow.toggleDevTools();
            }
        }
        ]
    },
    {
        label: 'Help',
        role: 'help',
        submenu: [
        {
            label: 'IF Reference Card',
            enabled: (special != 'card'),
            click: function(item, win) {
                if (!cardwin)
                    open_card_window();
                else
                    cardwin.show();
            }
        }
        ]
    }
    ];
    
    if (process.platform == 'darwin') {
        var stanza = find_in_template(template, 'Window');
        if (stanza) {
            stanza.submenu.push({
                type: 'separator'
            });
        }

        template.unshift({
            label: name,
            submenu: [
            {
                label: 'About ' + name,
                enabled: (special != 'about'),
                click: function() {
                    if (!aboutwin)
                        open_about_window();
                    else
                        aboutwin.show();
                    aboutwin_initial = false;
                }
            },
            { type: 'separator' },
            {
                label: 'Services',
                role: 'services',
                submenu: []
            },
            { type: 'separator' },
            {
                label: 'Hide ' + name,
                accelerator: 'Command+H',
                role: 'hide'
            },
            {
                label: 'Hide Others',
                accelerator: 'Command+Shift+H',
                role: 'hideothers'
            },
            {
                label: 'Show All',
                role: 'unhide'
            },
            { type: 'separator' },
            {
                label: 'Quit',
                accelerator: 'Command+Q',
                click: function() { app.quit(); }
            },
            ]
        });
    }
    else {
        var stanza = find_in_template(template, 'Help');
        if (stanza) {
            stanza.submenu.push({
                label: 'About ' + name,
                enabled: (special != 'about'),
                click: function(item, win) {
                    if (!aboutwin)
                        open_about_window();
                    else
                        aboutwin.show();
                    aboutwin_initial = false;
                }
            });
        }

        if (special) {
            var pos = index_in_template(template, 'View');
            if (pos >= 0) {
                template.splice(pos, 1);
            }
        }
    }

    return template;
}

/* --------------------------------------------------------------------
   Begin app setup.
 */

/* Ensure that only one Lectrote process exists at a time. */

var secondary = app.makeSingleInstance(function(argv, cwd) {
    /* This callback arrives when a second process tries to launch.
       Its arguments are sent here. */
    var count = 0;
    for (var ix=1; ix<argv.length; ix++) {
        var path = argv[ix];
        if (path_mod.basename(path) == 'main.js')
            continue;
        if (process.platform == 'darwin' && path.startsWith('-psn'))
            continue;
        if (!app_ready)
            launch_paths.push(path);
        else
            launch_game(path);
        count++;
    }

    if (!count) {
        /* The app was launched with no game arguments. To show willing,
           we'll pop up the about window. */
        if (!aboutwin) {
            open_about_window();
            aboutwin_initial = true;
        }
        else {
            aboutwin.show();
        }
    }
});
if (secondary) {
    /* Another process already exists. Our arguments have been sent
       to it. */
    app.quit();
    return;
}

/* Set up handlers. */

/* Called when the last window is closed; we shut down.
*/
app.on('window-all-closed', function() {
    app.quit();
});

/* Called when the app is going to quit, either because the last window
   closed or the user hit cmd-Q. 
*/
app.on('will-quit', function() {
    write_prefs_now();
});

electron.ipcMain.on('select_load_game', function() {
    if (isbound)
        return;
    select_load_game();
});

electron.ipcMain.on('select_load_recent', function() {
    if (isbound)
        return;
    var template = construct_recent_game_menu();
    if (!template || !template.length)
        return;
    var menu = electron.Menu.buildFromTemplate(template);
    menu.popup(aboutwin);
});

electron.ipcMain.on('game_metadata', function(ev, arg) {
    var game = game_for_webcontents(ev.sender);
    if (game) {
        if (arg.title)
            game.title = arg.title;
        if (arg.signature)
            game.signature = arg.signature;
    }
});

electron.ipcMain.on('pref_font', function(ev, arg) {
    prefs.gamewin_font = arg;
    note_prefs_dirty();
    for (var id in gamewins) {
        var game = gamewins[id];
        invoke_app_hook(game.win, 'set_font', prefs.gamewin_font);
    }
});

electron.ipcMain.on('pref_color_theme', function(ev, arg) {
    prefs.gamewin_colortheme = arg;
    note_prefs_dirty();
    for (var id in gamewins) {
        var game = gamewins[id];
        invoke_app_hook(game.win, 'set_color_theme', prefs.gamewin_colortheme);
    }
});

electron.ipcMain.on('pref_margin_level', function(ev, arg) {
    prefs.gamewin_marginlevel = arg;
    note_prefs_dirty();
    for (var id in gamewins) {
        var game = gamewins[id];
        invoke_app_hook(game.win, 'set_margin_level', prefs.gamewin_marginlevel);
    }
});

electron.ipcMain.on('pref_zoom_level', function(ev, arg) {
    prefs.gamewin_zoomlevel = arg;
    note_prefs_dirty();
    var val = zoom_factor_for_level(prefs.gamewin_zoomlevel);
    for (var id in gamewins) {
        var game = gamewins[id];
        invoke_app_hook(game.win, 'set_zoom_factor', val);
    }
});

/* Called at applicationWillFinishLaunching time (or before ready).
   Docs recommend setting up the open-file handler here.
*/
app.on('will-finish-launching', function() {
        
    var boundpath = process.env.npm_package_lectrotePackagedGame;
    if (boundpath) {
        /* We're in single-game mode. Do not handle command-line
           arguments or open-file events. Launch with the built-in
           path and no other. */
        isbound = true;
        launch_paths.push(boundpath);
        return;        
    }

    /* open-file events can come from the dock/taskbar, or (on MacOS)
       from the Finder handing us a double-clicked file. See 
       Lectrote.app/Contents/Info.plist for the definition of what
       file types the Finder will hand us. 

       This event can be received before ready time. If it is, then
       we have to stash the path for later use.
    */
    app.on('open-file', function(ev, path) {
        if (!app_ready)
            launch_paths.push(path);
        else
            launch_game(path);
    });

    /* If we were launched with "npm start game.ulx" then "game.ulx" is
       in process.argv. Unfortunately, the first argument may be "main.js"
       or not, depending on how we were launched. I don't know a way to
       distinguish this other than just special-casing "main.js".
       We also special-case the "-psn..." argument which MacOS sometimes
       throws in. */
    for (var ix=1; ix<process.argv.length; ix++) {
        var path = process.argv[ix];
        if (path_mod.basename(path) == 'main.js')
            continue;
        if (process.platform == 'darwin' && path.startsWith('-psn'))
            continue;
        launch_paths.push(path);
    }
});

/* Called when Electron is initialized and ready to run. 
*/
app.on('ready', function() {
    app_ready = true;

    load_prefs();
    
    var template = construct_menu_template();
    var menu = electron.Menu.buildFromTemplate(template);
    electron.Menu.setApplicationMenu(menu);

    /* If any paths have been received, launch them. If not, open an
       initial splash window. (In bound-game mode, launch_paths should
       contain exactly one path.) */

    if (!launch_paths.length) {
        open_about_window();
        aboutwin_initial = true;
    }
    else {
        for (var ix=0; ix<launch_paths.length; ix++)
            launch_game(launch_paths[ix]);
    }

    /* Won't need this any more */
    launch_paths = null;
});
