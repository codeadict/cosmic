const { Clutter, Gio, GLib, GObject, Shell, St } = imports.gi;
const { AppDisplay, AppIcon, AppSearchProvider } = imports.ui.appDisplay;
const { BaseIcon } = imports.ui.iconGrid;
const DND = imports.ui.dnd;
const { ExtensionState } = imports.misc.extensionUtils;
const Main = imports.ui.main;
const { ModalDialog, State } = imports.ui.modalDialog;
const OverviewControls = imports.ui.overviewControls;
const ParentalControlsManager = imports.misc.parentalControlsManager;
const { RemoteSearchProvider2 } = imports.ui.remoteSearch;
const Search = imports.ui.search;
const { getTermsForSearchString } = imports.ui.searchController;

let dialog = null;
let button_press_id = null;
let searchEntry = null;
let appDisplay = null;
let resultsView = null;
let inSearch = false;

// TODO css

var CosmicFolderButton = GObject.registerClass({
}, class CosmicFolderButton extends St.Button {
    _init(appDisplay, folder_settings) {
        this._appDisplay = appDisplay;
        this._folder_settings = folder_settings;

        let icon_name;
        if (folder_settings === null) {
            icon_name = 'go-home-symbolic';
        } else {
            icon_name = 'folder-symbolic';
            this._folder_settings.connect('changed::name', () => this._updateName());
        }

        this._icon = new BaseIcon("", { createIcon: size => {
            return new St.Icon ( { icon_name: icon_name, icon_size: size, style: "color: #9b9b9b" } );
        } });
        this._updateName();

        super._init({ child: this._icon, style_class: 'app-well-app' });
        this._delegate = this;
    }

    _updateName() {
        let name;

        if (this._folder_settings === null) {
            // TODO: translate
            name = 'Home';
        } else {
            name = this._folder_settings.get_string('name');
            if (this._folder_settings.get_boolean('translate')) {
                const translated = Shell.util_get_translated_folder_name(name);
                if (translated !== null)
                    name = translated;
            }
        }

        this._icon.label.text = name;
    }

    handleDragOver(source, _actor, _x, _y, _time) {
        if (!(source instanceof AppIcon) || !this.inAppDisplay(source))
            return DND.DragMotionResult.CONTINUE;

        return DND.DragMotionResult.COPY_DROP;
    }

    acceptDrop(source, _actor, _x, _y, _time) {
        if (!(source instanceof AppIcon) || !this.inAppDisplay(source))
            return false;

        const id = source.getId();

        // Remove from previous folder
        const prev_folder_id = this._appDisplay.getFolder();
        if (prev_folder_id !== null) {
            // XXX don't create new Gio.Settings
            const path = '%sfolders/%s/'.format(this._appDisplay._folderSettings.path, prev_folder_id);
            const prev_folder = new Gio.Settings({ schema_id: 'org.gnome.desktop.app-folders.folder',
                                                   path });

            let apps = prev_folder.get_strv('apps');
            apps = apps.filter(x => x !== id);
            prev_folder.set_strv('apps', apps)
        }

        if (this._folder_settings !== null) {
            let apps = this._folder_settings.get_strv('apps');
            if (!apps.includes(id))
                apps.push(id);
            this._folder_settings.set_strv('apps', apps);
        }

        return true;
    }

    inAppDisplay(app_icon) {
        for (let actor = app_icon; actor !== null; actor = actor.get_parent()) {
            if (actor === this._appDisplay)
                return actor;
        }
        return null;
    }
});

// ModalDialog normally fills screen, though that part of the widget is
// invisible. However, Gnome still treats it as the target for drag and
// drop, breaking drag to dock behavior. This implementation doesn't have
// that issue.
var CosmicModalDialog = GObject.registerClass({
}, class CosmicModalDialog extends ModalDialog {
    _init(params) {
        super._init(params);

        this.clear_constraints();
        this._backgroundBin.clear_constraints();
    }

    vfunc_allocate(box) {
        let index;
        if (this._monitorConstraint.primary)
            index = Main.layoutManager.primaryIndex;
        else
            index = Math.min(this._monitorConstraint.index, Main.layoutManager.monitors.length - 1);

        const monitor = Main.layoutManager.monitors[index];

        const width = box.x2 - box.x1;
        const height = box.y2 - box.y1;

        const x = (monitor.width - width) / 2;
        const y = (monitor.height - height) / 2;

        box.init_rect(monitor.x + x, monitor.y + y, width, height);
        this.set_allocation(box);

        const childBox = new Clutter.ActorBox();
        childBox.init_rect(0, 0, width, height);
        this._backgroundBin.allocate(childBox);
    }
});

// Normal FlowLayout doesn't work in a ScrollView. Overriding
// `vfunc_get_preferred_height` to return the `natHeight` as `minHeight`
// fixes this.
var CosmicAppFlowLayout = GObject.registerClass(
class CosmicAppFlowLayout extends Clutter.FlowLayout {
    vfunc_get_preferred_height(container, forWidth) {
        const [minHeight, natHeight] = super.vfunc_get_preferred_height(container, forWidth);
        return [natHeight, natHeight];
    }
});

// AppDisplay and the IconGrid don't work unless we want a paged layout with
// each app assigned to a particular page. So instead of using or subclassing
// that, reimplement with preferred design.
var CosmicAppDisplay = GObject.registerClass(
class CosmicAppDisplay extends St.Widget {
    _init() {
        super._init({
            layout_manager: new Clutter.BoxLayout({ orientation: Clutter.Orientation.VERTICAL }),
        });

        const rename_icon = new St.Icon ( { icon_name: 'edit-symbolic', icon_size: 32, style: "color: #9b9b9b" } );
        const rename_button = new St.Button({ child: rename_icon }); // TODO style?
        rename_button.connect('clicked', () => this.open_rename_folder_dialog());

        const delete_icon = new St.Icon ( { icon_name: 'edit-delete-symbolic', icon_size: 32, style: "color: #9b9b9b" } );
        const delete_button = new St.Button({ child: delete_icon }); // TODO style?
        delete_button.connect('clicked', () => this.open_delete_folder_dialog());

        // TODO add title, icons
        this._headerBox = new St.BoxLayout();
        this._headerBox.x_align = Clutter.ActorAlign.END;
        this._headerBox.add_actor(rename_button);
        this._headerBox.add_actor(delete_button);
        this.add_actor(this._headerBox);

        this._scrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            x_expand: true,
            overlay_scrollbars: true
        });
        this.add_actor(this._scrollView);

        this._parentalControlsManager = ParentalControlsManager.getDefault();
        this._parentalControlsManager.connect('app-filter-changed', () => {
            this._redisplay();
        });

        this._box = new St.Viewport({
            layout_manager: new CosmicAppFlowLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                homogeneous: true,
            }),
            x_expand: true,
            y_expand: true
        });
        this._scrollView.add_actor(this._box);

        Shell.AppSystem.get_default().get_installed().forEach(appInfo => {
            const app = Shell.AppSystem.get_default().lookup_app(appInfo.get_id());
            const icon = new AppIcon(app);
            this._box.add_actor(icon);
        });

        // TODO: Separator

        this._folderBox = new St.Viewport({
            layout_manager: new Clutter.FlowLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                homogeneous: true,
            }),
            x_expand: true,
        });
        this.add_actor(this._folderBox);

        this._folder_apps = {};

        this._redisplayWorkId = Main.initializeDeferredWork(this, this._redisplay.bind(this));

        this._folderSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.app-folders' });
        this._folderSettings.connect('changed::folder-children', () => {
            Main.queueDeferredWork(this._redisplayWorkId);
        });

        Shell.AppSystem.get_default().connect('installed-changed', () => {
            Main.queueDeferredWork(this._redisplayWorkId);
        });

        this._redisplay();

        this._updateHomeApps();
        this.setFolder(null);
    }

    _updateHomeApps() {
        this._home_apps = this._box.get_children().map(x => x.getId()).filter(id => {
            for (const k in this._folder_apps) {
                if (this._folder_apps[k].includes(id))
                    return false;
            }
            return true;
        });
    }

    getFolder() {
        return this._folder;
    }

    setFolder(folder) {
        this._folder = folder;

        const in_folder = (folder !== null);
        const ids = in_folder ? this._folder_apps[folder] : this._home_apps;

        // TODO: show title, edit/delete button

        this._box.get_children().forEach(app => {
            const appInfo = app.app.app_info;
            app.visible = this._parentalControlsManager.shouldShowApp(appInfo) &&
                          ids.includes(app.getId());
        });
    }

    _redisplay() {
        // TODO: check for new/removed apps

        // XXX check which folders changed
        this._folderBox.destroy_all_children();

        const home_button = new CosmicFolderButton(this, null);
        home_button.connect('clicked', () => this.setFolder(null));
        this._folderBox.add_actor(home_button);

        const folders = this._folderSettings.get_strv('folder-children');
        folders.forEach(id => {
            const path = '%sfolders/%s/'.format(this._folderSettings.path, id);
            const folder = new Gio.Settings({ schema_id: 'org.gnome.desktop.app-folders.folder',
                                              path });
            folder.connect('changed', () => {
                this._folder_apps[id] = folder.get_strv('apps');
                this._updateHomeApps();
                if (this._folder !== undefined)
                    this.setFolder(this._folder);
            });
            this._folder_apps[id] = folder.get_strv('apps');

            // TODO: categories, excluded-apps

            const folder_button = new CosmicFolderButton(this, folder);
            folder_button.connect('clicked', () => this.setFolder(id));
            this._folderBox.add_actor(folder_button);
        });

        // TODO translate
        const create_icon = new BaseIcon("Create Folder", { createIcon: size => {
            return new St.Icon ( { icon_name: 'folder-new-symbolic', icon_size: size, style: "color: #9b9b9b" } );
        } });
        const create_button = new St.Button({ child: create_icon, style_class: 'app-well-app' });
        create_button.connect('clicked', () => this.open_create_folder_dialog());
        this._folderBox.add_actor(create_button);
    }

    reset() {
        this.setFolder(null);
    }

    create_folder(name) {
        const newFolderId = GLib.uuid_string_random();
        const newFolderPath = this._folderSettings.path.concat('folders/', newFolderId, '/');
        const newFolderSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.app-folders.folder',
            path: newFolderPath,
        });

        if (!newFolderSettings) {
            log('Error creating new folder');
            return;
        }

        newFolderSettings.set_string('name', name);

        let folders = this._folderSettings.get_strv('folder-children');
        folders.push(newFolderId);
        this._folderSettings.set_strv('folder-children', folders);
    }

    delete_folder(id) {
        const folderPath = this._folderSettings.path.concat('folders/', id, '/');
        const folderSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.app-folders.folder',
            path: folderPath,
        });

        // Delete relocatable schema
        if (folderSettings) {
            let keys = folderSettings.settings_schema.list_keys();
            for (const key of keys)
                folderSettings.reset(key);
        }

        // Remove id from `folder-children`
        const folders = this._folderSettings.get_strv('folder-children');
        this._folderSettings.set_strv('folder-children', folders.filter(x => x !== id));
    }

    rename_folder(id, name) {
        const folderPath = this._folderSettings.path.concat('folders/', id, '/');
        const folderSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.app-folders.folder',
            path: folderPath,
        });

        if (folderSettings)
            folderSettings.set_string('name', name);
    }

    open_create_folder_dialog() {
        const dialog = new ModalDialog();
        dialog.connect("key-press-event", (_, event) => {
            if (event.get_key_symbol() == 65307)
                dialog.close();
        });

        const box = new St.BoxLayout({ vertical: true });
        dialog.contentLayout.add(box);

        const entry = new St.Entry();
        box.add_actor(entry);

        const button_box = new St.BoxLayout();
        box.add_actor(button_box);

        const cancel_label = new St.Label({ text: "Cancel" }); // TODO: translate
        const cancel_button = new St.Button({ child: cancel_label, style_class: 'modal-dialog-button button cancel-button' });
        cancel_button.connect('clicked', () => dialog.close());
        button_box.add_actor(cancel_button);

        const create_label = new St.Label({ text: "Create" }); // TODO: translate
        const create_button = new St.Button({ child: create_label, style_class: 'modal-dialog-button button' });
        create_button.connect('clicked', () => {
            this.create_folder(entry.get_text());
            dialog.close()
        });
        button_box.add_actor(create_button);

        dialog.open();
        entry.grab_key_focus();
    }

    open_delete_folder_dialog() {
        const id = this.getFolder();

        const dialog = new ModalDialog();
        dialog.connect("key-press-event", (_, event) => {
            if (event.get_key_symbol() == 65307)
                dialog.close();
        });

        const box = new St.BoxLayout({ vertical: true });
        dialog.contentLayout.add(box);

        const label = new St.Label({ text: "Delete folder?" }); // TODO: translate
        box.add_actor(label);

        const button_box = new St.BoxLayout();
        box.add_actor(button_box);

        const cancel_label = new St.Label({ text: "Cancel" }); // TODO: translate
        const cancel_button = new St.Button({ child: cancel_label, style_class: 'modal-dialog-button button cancel-button' });
        cancel_button.connect('clicked', () => dialog.close());
        button_box.add_actor(cancel_button);

        const delete_label = new St.Label({ text: "Delete" }); // TODO: translate
        const delete_button = new St.Button({ child: delete_label, style_class: 'modal-dialog-button button' });
        delete_button.connect('clicked', () => {
            this.delete_folder(id);
            dialog.close()
        });
        button_box.add_actor(delete_button);

        dialog.open();
    }

    open_rename_folder_dialog() {
        const id = this.getFolder();

        if (id === null)
            return;

        // XXX
        const folderPath = this._folderSettings.path.concat('folders/', id, '/');
        const folderSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.app-folders.folder',
            path: folderPath,
        });
        const name = folderSettings.get_string('name');

        const dialog = new ModalDialog();
        dialog.connect("key-press-event", (_, event) => {
            if (event.get_key_symbol() == 65307)
                dialog.close();
        });

        const box = new St.BoxLayout({ vertical: true });
        dialog.contentLayout.add(box);

        const entry = new St.Entry({ text: name });
        box.add_actor(entry);

        const button_box = new St.BoxLayout();
        box.add_actor(button_box);

        const cancel_label = new St.Label({ text: "Cancel" }); // TODO: translate
        const cancel_button = new St.Button({ child: cancel_label, style_class: 'modal-dialog-button button cancel-button' });
        cancel_button.connect('clicked', () => dialog.close());
        button_box.add_actor(cancel_button);

        const create_label = new St.Label({ text: "Rename" }); // TODO: translate
        const create_button = new St.Button({ child: create_label, style_class: 'modal-dialog-button button' });
        create_button.connect('clicked', () => {
            this.rename_folder(id, entry.get_text());
            dialog.close()
        });
        button_box.add_actor(create_button);

        dialog.open();
        entry.grab_key_focus();
    }
});

// This needs to implement an API similar to SearchResultsView since
// SearchResultsBase takes a SearchResultsView as an argument.
var CosmicSearchResultsView = GObject.registerClass({
    Signals: { 'terms-changed': {} },
}, class CosmicSearchResultsView extends St.BoxLayout {
    _init() {
        super._init();
        this._content = new Search.MaxWidthBox({
            name: 'searchResultsContent',
            vertical: true,
            x_expand: true,
        });
        this.add_actor(this._content);
        // TODO: scroll

        this._cancellable = new Gio.Cancellable();

        this._providers = [];
        this._terms = [];
        this._results = {};

        const provider = new AppSearchProvider();
        const providerDisplay = new Search.GridSearchResults(provider, this);
        this._content.add(providerDisplay)
        provider.display = providerDisplay;
        this._providers.push(provider);

        const appInfo = Gio.DesktopAppInfo.new("io.elementary.appcenter.desktop");
        const busName = "io.elementary.appcenter";
        const objectPath = "/io/elementary/appcenter/SearchProvider";
        if (appInfo) {
            const provider = new RemoteSearchProvider2(appInfo, busName, objectPath, true);
            const providerDisplay = new Search.ListSearchResults(provider, this);
            this._content.add(providerDisplay)
            provider.display = providerDisplay;
            this._providers.push(provider);
        }
    }

    get terms() {
        return this._terms;
    }

    setTerms(terms) {
        const searchString = terms.join(' ');
        const previousSearchString = this._terms.join(' ');

        // TODO
        this._terms = terms;
        this.emit('terms-changed');

        this._cancellable.cancel();
        this._cancellable.reset();

        // TODO timer

        let isSubSearch = false;
        if (this._terms.length > 0)
            isSubSearch = searchString.indexOf(previousSearchString) == 0;

        this._providers.forEach(provider => {
            provider.searchInProgress = true;

            const previousProviderResults = this._results[provider.id];
            if (isSubSearch && previousProviderResults) {
                provider.getSubsearchResultSet(previousProviderResults,
                                               this._terms,
                                               results => {
                                                   this._gotResults(results, provider);
                                               },
                                               this._cancellable);
            } else {
                provider.getInitialResultSet(this._terms,
                                             results => {
                                                 this._gotResults(results, provider);
                                             },
                                             this._cancellable);
            }
        });
    }

    _gotResults(results, provider) {
        const display = provider.display;
        const terms = this._terms;

        this._results[provider.id] = results;

        display.updateSearch(results, terms, () => {
            provider.searchInProgress = false;

            // XXX
        });
        // TODO
    }

    highlightTerms(description) {
        return ""; // TODO
    }
});

function fadeSearch(newInSearch) {
    if (newInSearch == inSearch)
        return;

    inSearch = newInSearch;

    let oldPage, newPage;
    if (inSearch)
        [oldPage, newPage] = [appDisplay, resultsView];
    else
        [oldPage, newPage] = [resultsView, appDisplay];

    oldPage.ease({
        opacity: 0,
        duration: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        //onStopped: () => this._animateIn(oldPage),
    });

    newPage.ease({
        opacity: 255,
        duration: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
}

function enable() {
    searchEntry = new St.Entry({
        style_class: 'search-entry',
        hint_text: _('Type to search'),
        track_hover: true,
        can_focus: true,
    });

    //appDisplay = new AppDisplay();
    appDisplay = new CosmicAppDisplay();
    appDisplay.set_size(1000, 1000); // XXX

    resultsView = new CosmicSearchResultsView();
    resultsView.opacity = 0;

    searchEntry.clutter_text.connect('text-changed', () => {
        const terms = getTermsForSearchString(searchEntry.get_text());
        resultsView.setTerms(terms);

        fadeSearch(searchEntry.get_text() !== '');
    });

    const stack = new Shell.Stack({});
    stack.add_child(resultsView);
    // Has to be top child to accept drag-and-drop
    stack.add_child(appDisplay);

    const box = new St.BoxLayout({ vertical: true });
    box.add_child(searchEntry);
    box.add_child(stack);

    dialog = new CosmicModalDialog({destroyOnClose: false, shellReactive: true});
    dialog.contentLayout.add(box);
    dialog.dialogLayout._dialog.style = "background-color: #36322f;";
    dialog.connect("key-press-event", (_, event) => {
        if (event.get_key_symbol() == 65307)
            hide();
    });

    button_press_id = global.stage.connect('button-press-event', () => {
        const [ width, height ] = dialog.dialogLayout._dialog.get_transformed_size();
        const [ x, y ] = dialog.dialogLayout._dialog.get_transformed_position();
        const [ cursor_x, cursor_y ] = global.get_pointer();

        if (dialog.visible && (cursor_x < x || cursor_x > x + width || cursor_y < y || cursor_y > y + height))
            hide();
    });
}

function disable() {
    searchEntry = null;
    appDisplay = null;
    resultsView = null;

    global.stage.disconnect(button_press_id);
    button_press_id = null;

    dialog.destroy();
    dialog = null;
}

function visible() {
    return dialog.state == State.OPENED || dialog.state == State.OPENING;
}

function show() {
    searchEntry.set_text('');
    appDisplay.reset();
    dialog.open();
    searchEntry.grab_key_focus();
}

function hide() {
    dialog.close();

    const cosmicDock = Main.extensionManager.lookup("cosmic-dock@system76.com");
    if (cosmicDock && cosmicDock.state === ExtensionState.ENABLED) {
        cosmicDock.stateObj.dockManager._allDocks.forEach((dock) => dock._onOverviewHiding());
    }
}
