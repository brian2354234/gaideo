
importScripts("/scripts/blockstack/blockstack.js", "/scripts/idb/index-min.js");

const initializeDatabase = async () => {
    let ret = true;
    if (!self.db) {
        self.db = await idb.openDB('gaideodb', 1, {
            upgrade(db, oldVersion, newVersion, transaction) {
                if (!oldVersion || oldVersion < 1) {
                    ret = false;
                }
            },
            blocked() {
                ret = false;
            },
            blocking() {
            },
            terminated() {
            },
        });
    }
    return ret;
}

const createMasterIndex = async () => {
    let masterIndex = {};
    await userSession.listFiles(name => {
        if ((name.startsWith("videos/") || name.startsWith("images/"))
            && name.endsWith('.index')) {
            masterIndex[name] = null;
        }
        return true;
    });
    try {
        await userSession.putFile('master-index', JSON.stringify(masterIndex), {
            encrypt: true,
            wasString: true,
            sign: true,
        });
    } catch {
        await userSession.deleteFile('master-index');
        await userSession.putFile('master-index', JSON.stringify(masterIndex), {
            encrypt: true,
            wasString: true,
            sign: true,
        });
    }
    return masterIndex;
}

const getMasterIndex = async (root, userName) => {
    let masterIndex = null;
    try {
        let fileName = 'master-index';
        if (root) {
            fileName = `${root}${fileName}`;
        }
        let json;
        if (userName) {
            const encryptedJson = await userSession.getFile(fileName, {
                decrypt: false,
                verify: false,
                username: userName
            });
            json = await userSession.decryptContent(encryptedJson);
        }
        else {
            json = await userSession.getFile(fileName, {
                decrypt: true,
                verify: true,
                username: userName
            });
        }
        if (json) {
            masterIndex = JSON.parse(json);
        }
    }
    catch {
    }
    return masterIndex;
}

const createIndexID = async (publicKey, index, userName) => {
    let idStr = `${publicKey}_${index}`;
    if (userName) {
        idStr = `${idStr}_${userName}`;
    }
    var idBuffer = new TextEncoder().encode(idStr);
    let id = blockstack.publicKeyToAddress(idBuffer);
    return id;
}

const getPublicKey = async (userName) => {
    let publicKey;
    if (userName) {
        let profile = await blockstack.lookupProfile(userName);
        if (profile) {
            let appMeta = profile.appsMeta[location.origin];
            if (appMeta) {
                return appMeta.publicKey;
            }
        }
    }
    else {
        publicKey = blockstack.getPublicKeyFromPrivate(sessionData.userData.appPrivateKey);
        return publicKey
    }
    throw new Error(`Unable to locate user: ${userName}.`);
}

const getUserDirectory = (publicKey) => {
    let addr = blockstack.publicKeyToAddress(publicKey);
    return `share/${addr}/`;
}

const getPrivateKeyFileName = (
    publicKey,
    id,
    type,
    userName) => {
    let root = '';
    if (userName) {
        root = getUserDirectory(publicKey);
    }
    let fileName = `${root}${type}/${id}/private.key`;
    return fileName;
}

const getPrivateKey = async (
    userSession,
    id,
    type,
    userName) => {
    let publicKey = blockstack.getPublicKeyFromPrivate(sessionData.userData.appPrivateKey);
    let privateKeyFile = getPrivateKeyFileName(publicKey, id, type, userName);
    let privateKey;
    try {
        if (userName) {
            const encryptedJson = await userSession.getFile(privateKeyFile, {
                decrypt: false,
                verify: false,
                username: userName
            });
            privateKey = await userSession.decryptContent(encryptedJson);
        }
        else {
            privateKey = await userSession.getFile(privateKeyFile, {
                decrypt: true,
                verify: true
            });
        }
    }
    catch {

    }
    return privateKey;
}

const removeCachedIndex = async (indexFile, pk) => {
    let publicKey = null;
    if (pk) {
        publicKey = pk;
    }
    else if (sessionData?.userData?.appPrivateKey) {
        publicKey = blockstack.getPublicKeyFromPrivate(sessionData.userData.appPrivateKey);
    }
    if (publicKey) {
        let id = await createIndexID(publicKey, indexFile);
        await db.delete('cached-indexes', id);
        return true;

    }
    return false;
}

const getIDFromIndexFileName = (fileName) => {
    let i = fileName?.lastIndexOf('/');
    if (i >= 0) {
        return fileName.substring(i + 1).replace('.index', '');
    }
    return null;
}

const getTypeFromIndexFileName = (fileName) => {
    let i = fileName.indexOf('/');
    if (i >= 0) {
        return fileName.substring(0, i);
    }
    return '';
}

const updateCachedIndex = async (indexFile, pk) => {
    let ownerPublicKey = null;
    if (pk) {
        ownerPublicKey = pk;
    }
    else if (sessionData?.userData?.appPrivateKey) {
        ownerPublicKey = blockstack.getPublicKeyFromPrivate(sessionData.userData.appPrivateKey);
    }
    if (ownerPublicKey) {
        let indexID = await createIndexID(ownerPublicKey, indexFile);
        let id = getIDFromIndexFileName(indexFile);
        let type = getTypeFromIndexFileName(indexFile);
        if (id) {
            let privateKey = await getPrivateKey(userSession, ownerPublicKey, id, type);
            if (privateKey) {
                let json = await userSession.getFile(indexFile, {
                    decrypt: privateKey
                });
                let metaData = JSON.parse(json);
                let encryptedJson = await userSession.encryptContent(json);
                let cachedIndex = {
                    data: encryptedJson,
                    id: indexID,
                    section: `${ownerPublicKey}_${metaData.type}`,
                    lastUpdated: metaData.lastUpdatedUTC
                }
                await db.put('cached-indexes', cachedIndex);
                return true;
            }
        }
    }
    return false;
}

const addIndexesToCache = async (indexFiles) => {
    if (sessionData?.userData?.appPrivateKey) {
        publicKey = blockstack.getPublicKeyFromPrivate(sessionData.userData.appPrivateKey);
        for (let i = 0; i < indexFiles.length; i++) {
            let indexFile = indexFiles[i];
            await updateCachedIndex(indexFile, publicKey);
        }
        return true;
    }
    return false;
}

const saveGaiaIndexesToCache = async (userName) => {
    let ret = 0;
    let hasExisting = false;
    try {
        let ownerPublicKey = blockstack.getPublicKeyFromPrivate(sessionData.userData.appPrivateKey);;
        let root = '';
        if (userName) {
            root = getUserDirectory(ownerPublicKey);
        }
        let masterIndex = await getMasterIndex(root, userName);
        if (masterIndex) {
            existingCache = {};
            const index = db.transaction('cached-indexes').store.index('section');
            if (index) {
                for (let i = 0; i < fileTypes?.length; i++) {
                    let cursor = await index.openCursor(`${ownerPublicKey}_${fileTypes[i]}`);
                    while (cursor) {
                        let canAdd = true;
                        if (!userName && cursor.value.shareName) {
                            canAdd = false;
                        }
                        else if (userName
                            && (!cursor.value.shareName || userName.toLowerCase() !== cursor.value.shareName.toLowerCase())) {
                            canAdd = false;
                        }
                        if (canAdd) {
                            existingCache[cursor.value.id] = cursor.value.lastUpdated;
                            hasExisting = true;
                        }
                        cursor = await cursor.continue();
                    }
                }
            }
            let latestUpdated = null;
            existing = {};
            missing = [];
            for (let indexFile in masterIndex) {
                try {
                    let indexID = await createIndexID(ownerPublicKey, indexFile, userName);
                    existing[indexID] = true;
                    let lastUpdated = masterIndex[indexFile];
                    let lastProcessed = existingCache[indexID];
                    if (!lastProcessed || (lastUpdated && lastUpdated > lastProcessed)) {
                        let id = getIDFromIndexFileName(indexFile);
                        if (id) {
                            let type = getTypeFromIndexFileName(indexFile);
                            let privateKey = await getPrivateKey(userSession, id, type, userName);
                            let json = await userSession.getFile(indexFile, {
                                decrypt: privateKey,
                                username: userName
                            });
                            let metaData = JSON.parse(json);

                            // old format skip
                            if (metaData.mediaType !== null && metaData.mediaType !== undefined) {
                                continue;
                            }

                            if (!latestUpdated || latestUpdated < metaData.lastUpdatedUTC) {
                                latestUpdated = metaData.lastUpdatedUTC;
                            }
                            let encryptedJson = await userSession.encryptContent(json);
                            let cachedIndex = {
                                data: encryptedJson,
                                id: indexID,
                                section: `${ownerPublicKey}_${metaData.type}`,
                                lastUpdated: metaData.lastUpdatedUTC,
                                shareName: userName
                            }
                            await db.put('cached-indexes', cachedIndex);
                            ret++;
                        }
                    }
                }
                catch (metaDataError) {
                    missing.push(indexFile)
                    console.log(metaDataError);
                }
            }
            if (!userName && missing.length > 0) {
                missing.forEach(x => {
                    delete masterIndex[x];
                })
                await userSession.putFile("master-index", JSON.stringify(masterIndex), {
                    encrypt: true,
                    wasString: true,
                    sign: true
                })
            }
            for (let key in existingCache) {
                if (!existing[key]) {
                    await db.delete('cached-indexes', key);
                }
            }
        }
    }
    catch (error) {
        console.log(error);
    }
    return [ret, hasExisting];
}

const initializeUserSession = (e) => {
    if (!self.userSession || !self.userSession.isUserSignedIn()) {
        self.fileTypes = e.data.fileTypes;
        let sessionData = JSON.parse(e.data.sessionData);
        let appConfig = new self.blockstack.AppConfig(['store_write'], e.data.location)
        self.userSession = new self.blockstack.UserSession({
            appConfig: appConfig,
            sessionOptions: sessionData
        });
        self.sessionData = sessionData;
        self.origin = e.data.origin;
        self.location = e.data.location;
    }
}

const getShares = async () => {
    let shares = {};
    try {
        let json = await userSession?.getFile("share-index", {
            decrypt: true,
            verify: true
        });
        if (json) {
            shares = JSON.parse(json);
        }
    }
    catch {

    }
    return shares;
}

const getGroupIndex = async (userSession, id) => {
    let groupIndex = {}
    try {
        let json = await userSession.getFile(`groups/${id}.index`, {
            decrypt: true,
            verify: true
        });
        if (json) {
            groupIndex = JSON.parse(json);
        }
    }
    catch {

    }
    return groupIndex;
}

const validateGroupEntries = async (e) => {
    if (e && e.data.groupid && e.data.missing && e.data.missing.length > 0) {
        let groupIndex = await getGroupIndex(userSession, e.data.groupid);
        if (groupIndex) {
            let saveFlag = false;
            for (let i = 0; i < e.data.missing.length; i++) {
                let x = e.data.missing[i];
                let found = true;
                try {
                    await userSession.getFile(x.indexFile, {
                        decrypt: false,
                        verify: false,
                        username: x.userName
                    })
                }
                catch {
                    found = false;
                }
                if (!found && groupIndex[x.indexFile]) {
                    delete groupIndex[x.indexFile];
                    saveFlag = true;
                }
            }
            if (saveFlag) {
                try {
                    await userSession.putFile(`groups/${e.data.groupid}.index`, JSON.stringify(groupIndex), {
                        encrypt: true,
                        sign: true
                    });
                }
                catch (error) {
                    console.log(error);
                }
            }
        }
    }
}

self.addEventListener(
    "message",
    async function (e) {
        let message;
        switch (e.data.message) {
            case "load":
                try {
                    await initializeDatabase();
                    initializeUserSession(e);
                    if (userSession?.isUserSignedIn()) {
                        try {
                            await userSession.getFile('master-index', {
                                decrypt: true,
                                verify: true
                            });
                        }
                        catch {
                            await createMasterIndex();
                        }
                        let results = await saveGaiaIndexesToCache();
                        let shares = await getShares();
                        for (key in shares) {
                            saveGaiaIndexesToCache(key);
                        }
                        postMessage({
                            message: 'loadcomplete',
                            result: true,
                            addedCount: results[0],
                            hasExisting: results[1]
                        });
                    }
                    else {
                        postMessage({
                            message: 'Unable to load data because userSession is not signed in.',
                            result: false
                        })
                    }

                }
                catch (error) {
                    postMessage({
                        message: error,
                        result: false
                    });
                }

                break;
            case "cacheindexes":
                message = 'Unable to add index to cache.';
                if (userSession?.isUserSignedIn()
                    && e.data.indexFiles?.length > 0) {
                    try {
                        if (await addIndexesToCache(e.data.indexFiles)) {
                            message = null;
                        }
                    }
                    catch (error) {
                        message = error;
                    }
                }
                if (message) {
                    postMessage({
                        message: message,
                        result: false
                    })
                }
                else {
                    postMessage({
                        message: "cacheindexescomplete",
                        result: true
                    })
                }
                break;
            case "removecache":
                message = 'Unable to delete cached index.';
                if (userSession?.isUserSignedIn()
                    && e.data.indexFile?.length > 0) {
                    try {
                        if (await removeCachedIndex(e.data.indexFile)) {
                            message = null;
                        }
                    }
                    catch (error) {
                        message = error;
                    }
                }
                if (message) {
                    postMessage({
                        message: message,
                        result: false
                    })
                }
                else {
                    postMessage({
                        message: "removecachecomplete",
                        result: true
                    })
                }
                break;
            case "updatecache":
                message = 'Unable to update cached index.';
                if (userSession?.isUserSignedIn()
                    && e.data.indexFile?.length > 0) {
                    try {
                        if (await updateCachedIndex(e.data.indexFile)) {
                            message = null;
                        }
                    }
                    catch (error) {
                        message = error;
                    }
                }
                if (message) {
                    postMessage({
                        message: message,
                        result: false
                    })
                }
                else {
                    postMessage({
                        message: "updatecachecomplete",
                        result: true
                    })
                }
                break;
            case "deletedb":
                db?.close();
                await idb.deleteDB("gaideodb", {
                    blocked() {
                        console.log("Unable to delete cached indexes database because all connections could not be closed.")
                    }
                });
                postMessage({
                    message: "deletedbcomplete",
                    result: true
                })
                break;
            case "validate-group-entries":
                await validateGroupEntries(e);
                postMessage({
                    message: "validate-group-entries-complete",
                    result: true
                })
                break;
            default:
                postMessage({
                    message: 'unknown',
                    result: false
                });
                break;
        }
    },
    false
);

postMessage({
    message: "ready",
    result: true
})