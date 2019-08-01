Game.prototype.verbotenWords = [
    '.call', 'call(', 'apply', 'bind', // prevents arbitrary code execution
    'prototype', // prevents messing with prototypes
    'debugger', // prevents pausing execution
    'delete', // prevents removing items
    'constructor', // prevents retrieval of Function using an instance of it
    'window', // prevents setting "window.[...] = map", etc.
    'top', // prevents user code from escaping the iframe
    'validate', 'onExit', 'objective', // don't let players rewrite these methods
    'this[', // prevents this['win'+'dow'], etc.
     '\\u' // prevents usage of arbitrary code through unicode escape characters, see issue #378
];
Game.prototype.allowedTime = 2000; // for infinite loop prevention

var DummyDisplay = function () {
    this.clear = function () {};
    this.drawAll = function () {};
    this.drawObject = function () {};
    this.drawText = function () {};
    this.writeStatus = function () {};
};

Game.prototype.validate = function(allCode, playerCode, restartingLevelFromScript) {
    var game = this;

    try {
        for (var i = 0; i < this.verbotenWords.length; i++) {
            var badWord = this.verbotenWords[i];
            if (playerCode.indexOf(badWord) > -1) {
                throw "You are not allowed to use '" + badWord + "'!";
            }
        }

        var dummyMap = new Map(new DummyDisplay(), this);
        dummyMap._dummy = true;
        dummyMap._setProperties(this.editor.getProperties().mapProperties);

        // modify the code to always check time to prevent infinite loops
        allCode = allCode.replace(/\)\s*{/g, ") {"); // converts Allman indentation -> K&R
        allCode = allCode.replace(/\n\s*while\s*\((.*)\)/g, "\nfor (dummy=0;$1;)"); // while -> for
        allCode = $.map(allCode.split('\n'), function (line, i) {
            return line.replace(/for\s*\((.*);(.*);(.*)\)\s*{/g,
                "for ($1, startTime = Date.now();$2;$3){" +
                    "if (Date.now() - startTime > " + game.allowedTime + ") {" +
                        "throw '[Line " + (i+1) + "] TimeOutException: Maximum loop execution time of " + game.allowedTime + " ms exceeded.';" +
                    "}");
        }).join('\n');

        if (this._debugMode) {
            console.log(allCode);
        }

        // save reference implementations to prevent tampering
        this.saveReferenceImplementations(dummyMap, dummyMap.getPlayer());

        var allowjQuery = dummyMap._properties.showDummyDom;
        // setup iframe in which code is run. As a side effect, this sets `this._eval` correctly
        var userCode = this.initIframe(allowjQuery);

        // evaluate the code to get startLevel() and (opt) validateLevel() methods

        this._eval(allCode);
        var initialOnExit = userCode.onExit;
        var initialValidateLevel = userCode.validateLevel;

        // start the level on a dummy map to validate
        this._setPlayerCodeRunning(true);
        userCode.startLevel(dummyMap);
        this._setPlayerCodeRunning(false);

        // re-run to check if the player messed with startLevel
        this._startOfStartLevelReached = false;
        this._endOfStartLevelReached = false;
        dummyMap._reset();
        this._setPlayerCodeRunning(true);
        userCode.startLevel(dummyMap);
        this._setPlayerCodeRunning(false);
        dummyMap._clearIntervals();

        // does startLevel() execute fully?
        // (if we're restarting a level after editing a script, we can't test for this
        // - nor do we care)
        if (!this._startOfStartLevelReached && !restartingLevelFromScript) {
            throw 'startLevel() has been tampered with!';
        }
        if (!this._endOfStartLevelReached && !restartingLevelFromScript) {
            throw 'startLevel() returned prematurely!';
        }
        // issue#385 check for tampering with validateLevel and startLevel
        if(initialValidateLevel !== userCode.validateLevel) {
            throw "validateLevel() has been tampered with!";
        }
        if(initialOnExit !== userCode.onExit) {
            throw "onExit() has been tampered with!";
        }

        // has the player tampered with any functions?
        this.detectTampering(dummyMap, dummyMap.getPlayer());

        this.validateLevel = function () { return true; };
        // does validateLevel() succeed?
        if (typeof(userCode.validateLevel) === "function") {
            this.validateLevel = userCode.validateLevel;
            userCode.validateLevel(dummyMap);
        }

        this.onExit = function () { return true; };
        if (typeof userCode.onExit === "function") {
            this.onExit = userCode.onExit;
        }

        this.objective = function () { return false; };
        if (typeof userCode.objective === "function") {
            this.objective = userCode.objective;
        }

        return userCode.startLevel;
    } catch (e) {
        // cleanup
        this._setPlayerCodeRunning(false);

        var exceptionText = e.toString();
        if (e instanceof SyntaxError) {
            var lineNum = this.findSyntaxError(allCode, e.message);
            if (lineNum) {
                exceptionText = "[Line " + lineNum + "] " + exceptionText;
            }
        }
        this.display.appendError(exceptionText);

        // throw e; // for debugging
        return null;
    }
};

// makes sure nothing un-kosher happens during a callback within the game
// e.g. item collison; function phone
Game.prototype.validateCallback = function(callback, throwExceptions, ignoreForbiddenCalls) {
    var savedException = null;
    var exceptionFound = false;
    try {
        // run the callback and check for forbidden method calls
        try {
            if (!ignoreForbiddenCalls) {
                this._setPlayerCodeRunning(true);
            }
            var result = callback();
            this._setPlayerCodeRunning(false);
        } catch (e) {
            // cleanup
            this._setPlayerCodeRunning(false);

            if (e.toString().indexOf("Forbidden method call") > -1 ||
                e.toString().indexOf("Attempt to modify private property") > -1 ||
                e.toString().indexOf("Attempt to read private property") > -1) {
                // display error, disable player movement
                this.display.appendError(e.toString(), "%c{red}Please reload the level.");
                this.sound.playSound('static');
                this.map.getPlayer()._canMove = false;
                this.map._callbackValidationFailed = true;
                this.map._clearIntervals();
                // throw e; // for debugging
                return;
            } else {
                // other exceptions are fine here, but be sure to run validation before passing them up
                savedException = e;
                exceptionFound = true;
            }
        }

        // check if validator still passes
        try {
            if (typeof(this.validateLevel) === 'function') {
                this.validateLevel(this.map);
            }
        } catch (e) {
            // validation failed - not much to do here but restart the level, unfortunately
            this.display.appendError(e.toString(), "%c{red}Validation failed! Please reload the level.");

            // play error sound
            this.sound.playSound('static');

            // disable player movement
            this.map.getPlayer()._canMove = false;
            this.map._callbackValidationFailed = true;
            this.map._clearIntervals();
            return;
        }

        // on maps with many objects (e.g. boss fight),
        // we can't afford to do these steps
        if (!this.map._properties.quickValidateCallback) {

            // has the player tampered with any functions?
            try {
                this.detectTampering(this.map, this.map.getPlayer());
            } catch (e) {
                this.display.appendError(e.toString(), "%c{red}Validation failed! Please reload the level.");

                // play error sound
                this.sound.playSound('static');

                // disable player movement
                this.map.getPlayer()._canMove = false;
                this.map._callbackValidationFailed = true;
                this.map._clearIntervals();
                return;
            }
            if(exceptionFound) {
                throw savedException;
            }
            // refresh the map, just in case
            this.map.refresh();

            return result;
        }
        if(exceptionFound) {
            throw savedException;
        }
    } catch (e) {
        this.map.writeStatus(e.toString());

        // throw e; // for debugging
        if (throwExceptions) {
            throw e;
        }
    }
};

Game.prototype.validateAndRunScript = function (code) {
    try {
        // Game.prototype.blah => game.blah
        code = code.replace(/Game.prototype/, 'this');

        // Blah => game._blahPrototype
        code = code.replace(/function Map/, 'this._mapPrototype = function');
        code = code.replace(/function Player/, 'this._playerPrototype = function');

        new Function(code).bind(this).call(); // bind the function to current instance of game!

        if (this._mapPrototype) {
            // re-initialize map if necessary
            this.map._reset(); // for cleanup
            this.map = new this._mapPrototype(this.display, this);
        }

        // re-initialize objects if necessary
        this.objects = this.getListOfObjects();

        // and restart current level from saved state
        var savedState = this.editor.getGoodState(this._currentLevel);
        this._evalLevelCode(savedState['code'], savedState['playerCode'], false, true);
    } catch (e) {
        this.display.writeStatus(e.toString());
        //throw e; // for debugging
    }
}
var allowedGlobals = {
    // These four are allowed primarily to avoid confusing the programmer
    'Object':true,
    'Array':true,
    'String':true,
    'Number':true,
    // Math.Floor and Math.random are used in many levels
    'Math':true,
    // parseInt is used in a few bonus levels
    'parseInt':true,
    // Date is used by the infinite loop prevention code
    'Date':true
}

Game.prototype.initIframe = function(allowjQuery){
    var iframe = $("#user_code")[0];
    // reset any state in the iframe
    iframe.src = "about:blank";
    var iframewindow = iframe.contentWindow;
    this._eval = iframewindow.eval;
    // delete any unwated global variables in the iframe
    function purgeObject(object) {
        var globals = Object.getOwnPropertyNames(object);
        for (var i = 0;i < globals.length;i++) {
            var variable = globals[i];
            if (!allowedGlobals.hasOwnProperty(variable)) {
                delete object[variable];
            }
        }
        var prototype = Object.getPrototypeOf(object);
        if (prototype && prototype != iframewindow.Object.prototype) {
            purgeObject(prototype);
        }
    }
    purgeObject(iframewindow);
    // document can't be deleted, so purge it instead
    purgeObject(iframewindow.document);
    // add in any necessary global variables
    iframewindow.ROT = {Map: {DividedMaze: ROT.Map.DividedMaze }}
    if (allowjQuery) {
        // this is not secure, however it doesn't matter since the only level
        // with showDummyDom set has no editable code
        iframewindow.$ = iframewindow.jQuery = jQuery;
    }
    return iframewindow;
}

// takes an object and modifies it so that all properties starting with `_`
// throw an error when accessed in level code
Game.prototype.secureObject = function(object, errorstring) {
    errorstring = errorstring || "";
    for (var prop in object) {
        if(prop == "_startOfStartLevelReached" || prop == "_endOfStartLevelReached"){
            // despite starting with an _, these two properties are intended to be called from map code
            continue;
        }
        if(prop[0] == "_"){
            this.secureProperty(object, prop, errorstring);
        }
    }
}
Game.prototype.secureProperty = function(object, prop, errorstring){
    var val = object[prop];
    var game = this;
    Object.defineProperty(object, prop, {
            configurable:false,
            enumerable:false,
            get:function(){
                if (game._isPlayerCodeRunning()) {
                    throw "Attempt to read private property " + errorstring + prop;
                }
                return val;
            },
            set:function(newValue){
                if(game._isPlayerCodeRunning()) {
                    throw "Attempt to modify private property " + errorstring + prop;
                }
                val = newValue
            }
    });
}

// awful awful awful method that tries to find the line
// of code where a given error occurs
Game.prototype.findSyntaxError = function(code, errorMsg) {
    var lines = code.split('\n');
    for (var i = 1; i <= lines.length; i++) {
        var testCode = lines.slice(0, i).join('\n');

        try {
            this._eval(testCode);
        } catch (e) {
            if (e.message === errorMsg) {
                return i;
            }
        }
    }
    return null;
};

// Function tampering prevention

Game.prototype.referenceImplementations = {
    'map': {
        'countObjects': '',
        'createFromDOM': '',
        'createFromGrid': '',
        'displayChapter': '',
        'defineObject': '',
        'getAdjacentEmptyCells': '',
        'getCanvasContext': '',
        'getCanvasCoords': '',
        'getDOM': '',
        'getDynamicObjects': '',
        'getHeight': '',
        'getObjectTypeAt': '',
        'getPlayer': '',
        'getRandomColor': '',
        'getWidth': '',
        'isStartOfLevel': '',
        'overrideKey': '',
        'placeObject': '',
        'placePlayer': '',
        'setSquareColor': '',
        'startTimer': '',
        'updateDOM': '',
        'validateAtLeastXObjects': '',
        'validateAtMostXObjects': '',
        'validateExactlyXManyObjects': '',
        'validateAtMostXDynamicObjects': '',
        'validateNoTimers': '',
        'validateAtLeastXLines': ''
    },
    'player': {
        'atLocation': '',
        'getColor': '',
        'getLastMoveDirection': '',
        'getX': '',
        'getY': '',
        'hasItem': '',
        'killedBy': '',
        'move': '',
        'removeItem': '',
        'setColor': '',
        'setPhoneCallback': ''
    }
}

Game.prototype.saveReferenceImplementations = function(map, player) {
    if (map) {
        for (f in this.referenceImplementations.map) {
            if (this.referenceImplementations.map.hasOwnProperty(f)) {
                this.referenceImplementations.map[f] = map[f];
            }
        }
    }
    if (player) {
        for (f in this.referenceImplementations.player) {
            if (this.referenceImplementations.player.hasOwnProperty(f)) {
                this.referenceImplementations.player[f] = player[f];
            }
        }
    }
};

Game.prototype.detectTampering = function(map, player) {
    // once the super menu is activated, we don't care anymore!
    if (this._superMenuActivated) {
        return;
    }

    for (f in this.referenceImplementations.map) {
        if (this.referenceImplementations.map.hasOwnProperty(f)) {
            if (this.referenceImplementations.map[f] !== map[f]) {
                throw (f + '() has been tampered with!');
            }
        }
    }

    if (player) {
        for (f in this.referenceImplementations.player) {
            if (this.referenceImplementations.player.hasOwnProperty(f)) {
                if (this.referenceImplementations.player[f] !== player[f]) {
                    throw (f + '() has been tampered with!');
                }
            }
        }
    }
};
