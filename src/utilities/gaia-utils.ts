import { getPublicKeyFromPrivate, lookupProfile, makeECPrivateKey, publicKeyToAddress, UserSession } from "blockstack";
import { IDBPCursorWithValue, IDBPDatabase } from 'idb';
import { CacheEntry, CacheResults } from "../models/cache-entry";
import { UserData } from "blockstack/lib/auth/authApp";
import { ShareUserEntry } from "../models/share-user-entry";
import { FileRootInfo } from "../models/file-root-info";
import { Group, GroupEntry } from "../models/group";
import { FileOperation } from "../models/file-operation";
import { FileEntry } from "../models/file-entry";
import { FileMetaData } from "../models/file-meta-data";

export async function getPublicKey(userData: UserData, userName: string | null | undefined) {
    let publicKey;
    if (userName && userName !== userData.username) {
        let profile = await lookupProfile(userName);
        if (profile) {
            let appMeta = profile.appsMeta[document.location.origin];
            if (appMeta) {
                return appMeta.publicKey;
            }
        }
    }
    else {
        publicKey = getPublicKeyFromPrivate(userData.appPrivateKey);
        return publicKey
    }
    throw new Error(`Unable to locate user: ${userName}.`);
}

export function createHashAddress(values: string[]) {
    let value = values.join('_');
    var idBuffer = new TextEncoder().encode(value) as Buffer;
    let ret = publicKeyToAddress(idBuffer);
    return ret;

}

const getMasterIndex = async (userSession: UserSession, fileName: string, canCreate: boolean) => {
    let ret = null;
    try {
        let json = await userSession.getFile(fileName, {
            decrypt: true,
            verify: true
        }) as string;
        if (json) {
            ret = JSON.parse(json);
        }
    }
    catch {
        if (canCreate) {
            ret = {};
        }
    }
    return ret;
}

export function getUserDirectory(publicKey: string) {
    let addr = publicKeyToAddress(publicKey);
    return `share/${addr}/`;
}

export async function getShareRootInfo(
    userData: UserData,
    isReading: boolean,
    userName?: string): Promise<FileRootInfo> {
    let ret = '';
    let publicKey;
    if (userName) {
        if (isReading) {
            publicKey = getPublicKeyFromPrivate(userData.appPrivateKey);
        }
        else {
            publicKey = await getPublicKey(userData, userName)
        }
        ret = getUserDirectory(publicKey);
    }
    else {
        publicKey = getPublicKeyFromPrivate(userData.appPrivateKey);
    }
    return {
        root: ret,
        publicKey: publicKey
    };
}

export async function updateMasterIndex(
    userSession: UserSession,
    gaiaWorker: Worker | null,
    operation: FileOperation,
    fileEntries: FileEntry[],
    userName: string | undefined = undefined
) {
    try {
        if (userName
            && operation !== FileOperation.Share
            && operation !== FileOperation.Unshare
            && operation !== FileOperation.Update
            && operation !== FileOperation.Delete) {
            const msg = `Invalid operation for user name: ${userName}.  Only share and unshare operations are allowed`
            console.log(msg);
            throw Error(msg);
        }
        if (fileEntries?.length > 0) {
            let fileName = null;
            let publicFileName = null;
            let userData = userSession.loadUserData();
            let fileRootInfo = await getShareRootInfo(userData, false, userName);
            if (fileRootInfo.root.length > 0) {
                publicFileName = `${fileRootInfo.root}master-index`;
                fileName = `${fileRootInfo.root}internal-index`;
            }
            else {
                fileName = "master-index";
            }
            if (fileName) {
                let masterIndex = await getMasterIndex(userSession, fileName, operation !== FileOperation.Delete);
                if (masterIndex) {
                    let modified = false;
                    const privateLookup: any = {};
                    for (let i = 0; i < fileEntries.length; i++) {
                        let metaData = fileEntries[i].metaData;
                        if (operation === FileOperation.Delete
                            || operation === FileOperation.Unshare) {
                            if (masterIndex[fileEntries[i].indexFile]) {
                                delete masterIndex[fileEntries[i].indexFile];
                                modified = true;
                            }
                        }
                        else {
                            if (operation !== FileOperation.Update || masterIndex[fileEntries[i].indexFile]) {
                                masterIndex[fileEntries[i].indexFile] = fileEntries[i].metaData.lastUpdatedUTC;
                                modified = true;
                            }
                        }
                        if ((operation === FileOperation.Share
                            || operation === FileOperation.Unshare
                            || operation === FileOperation.Delete)
                            && modified && publicFileName) {
                            const sharePrivateKeyFile = getPrivateKeyFileName(fileRootInfo.root, metaData.id, metaData.type);
                            if (operation === FileOperation.Share) {
                                let privateKey = await getPrivateKey('', userSession, metaData.id, metaData.type);
                                if (privateKey) {
                                    let encryptedKey = await userSession.encryptContent(privateKey, {
                                        publicKey: fileRootInfo.publicKey
                                    })
                                    privateLookup[sharePrivateKeyFile] = encryptedKey;
                                }
                                else {
                                    const msg = `Unable to get private key for sharing.`;
                                    console.log(msg);
                                    throw new Error(msg);
                                }
                            }
                            else {
                                privateLookup[sharePrivateKeyFile] = null;
                            }
                        }
                    }
                    if (modified) {
                        await userSession.putFile(fileName, JSON.stringify(masterIndex), {
                            encrypt: true,
                            sign: true,
                            wasString: true
                        });
                        if (publicFileName && fileRootInfo.publicKey) {
                            for (let key in privateLookup) {
                                try {
                                    if (operation === FileOperation.Share) {
                                        await userSession.putFile(key, privateLookup[key], {
                                            encrypt: false,
                                            sign: false,
                                            wasString: true
                                        });
                                    }
                                    else {
                                        await userSession.deleteFile(key);
                                    }
                                }
                                catch { }
                            }
                        }
                        else if (operation === FileOperation.Delete || operation === FileOperation.Update) {
                            let shares = await getShares(userSession);
                            if (shares) {
                                for (let userName in shares) {
                                    await updateMasterIndex(userSession, null, operation, fileEntries, userName);
                                }
                            }
                        }
                    }
                    if (publicFileName && fileRootInfo.publicKey) {
                        let json = JSON.stringify(masterIndex);
                        let encryptedJson = await userSession.encryptContent(json, {
                            publicKey: fileRootInfo.publicKey
                        });
                        await userSession.putFile(publicFileName, encryptedJson, {
                            encrypt: false,
                            sign: false,
                            wasString: true
                        });
                    }

                }
            }
        }
    }
    catch {

    }
    if (gaiaWorker) {
        if (operation === FileOperation.Delete) {
            fileEntries.forEach(x => {
                gaiaWorker.postMessage({
                    message: "removecache",
                    indexFile: x.indexFile
                })

            })

        }
        else if (operation === FileOperation.Update) {
            fileEntries.forEach(x => {
                gaiaWorker.postMessage({
                    message: "updatecache",
                    indexFile: x.indexFile
                });
            })
        }
        else if (operation === FileOperation.Add) {
            gaiaWorker.postMessage({
                message: "cacheindexes",
                indexFiles: fileEntries.map(x => x.indexFile)
            });
        }
    }
}

export async function listFiles(userSession: UserSession) {
    await userSession.listFiles(name => {
        console.log(name);
        return true;
    })
}

export async function shareFile(fileEntries: FileMetaData[], userSession: UserSession, shareUsers: ShareUserEntry[], unshare: boolean) {
    const files: FileEntry[] = fileEntries.map(x => {
        return {
            metaData: x,
            indexFile: `${x.type}/${x.id}.index`
        }
    });
    const op = unshare ? FileOperation.Unshare : FileOperation.Share;
    for (let i = 0; i < shareUsers.length; i++) {
        let su = shareUsers[i]
        if (su.share) {
            await updateMasterIndex(userSession, null, op, files, su.userName);
        }
    }
}

export function getFileIDFromIndexFileName(fileName: string) {
    let i = fileName.lastIndexOf('/');
    if (i >= 0) {
        return fileName.substring(i + 1).replace('.index', '');
    }
    return null;
}

export function getTypeFromIndexFileName(fileName: string) {
    let i = fileName.indexOf('/');
    if (i >= 0) {
        return fileName.substring(0, i);
    }
    return '';
}

export async function createIndexID(publicKey: string, index: string, userName: string | undefined) {
    let idStr = `${publicKey}_${index}`;
    if (userName && userName.length > 0) {
        idStr = `${idStr}_${userName}`;
    }
    var idBuffer = Buffer.from(new TextEncoder().encode(idStr));
    let id = publicKeyToAddress(idBuffer);
    return id;
}

export async function getCacheEntriesFromGroup(
    userSession: UserSession,
    db: IDBPDatabase<unknown>,
    type: string,
    gaiaWorker: Worker | null,
    groupid: string,
    max: number | null,
    cacheResults: CacheResults | null) {

    let allEntries: CacheEntry[] = [];
    let nextIndex: IDBValidKey | null = null;
    if (!cacheResults?.allEntries) {
        let ud = userSession.loadUserData();
        const publicKey = getPublicKeyFromPrivate(ud.appPrivateKey);
        const groupIndex = await getGroupIndex(userSession, groupid) as any;
        const missing: GroupEntry[] = [];
        if (groupIndex) {
            for (let key in groupIndex) {
                const currentType = getTypeFromIndexFileName(key);
                if (currentType === type) {
                    let uname = groupIndex[key];
                    if (uname && uname === ud.username) {
                        uname = undefined;
                    }
                    const id = await createIndexID(publicKey, key, uname);
                    const entry = await db.get('cached-indexes', id) as CacheEntry;
                    if (entry) {
                        allEntries.push(entry);
                    }
                    else {
                        missing.push({
                            groupid: groupid,
                            indexFile: key,
                            userName: uname
                        });
                    }
                }
            }
            if (missing.length > 0 && gaiaWorker) {
                gaiaWorker.postMessage({
                    message: "validate-group-entries",
                    missing: missing,
                    groupid: groupid
                });
            }
            allEntries.sort((x, y) => {
                if (!x && y) {
                    return -1;
                }
                else if (x && !y) {
                    return 1;
                }
                else if (x.lastUpdated < y.lastUpdated) {
                    return -1;
                }
                else if (x.lastUpdated > y.lastUpdated) {
                    return 1;
                }
                else {
                    return 0;
                }
            })
        }
    }
    else {
        allEntries = cacheResults.allEntries;
    }
    let count = 0;
    let cacheEntries: CacheEntry[] = [];
    let startIndex = 0;
    if (cacheResults?.nextKey) {
        const idx = cacheResults.nextKey as number;
        if (idx > 0) {
            startIndex = idx;
        }
    }
    while (startIndex < allEntries.length) {
        cacheEntries.push(allEntries[startIndex]);
        count++;
        startIndex++;
        if (max != null && count >= max) {
            if (startIndex < allEntries.length) {
                nextIndex = startIndex;
            }
            break;
        }
    }
    return {
        cacheEntries: cacheEntries,
        nextKey: nextIndex,
        nextPrimaryKey: nextIndex,
        allEntries: allEntries
    }
}

export async function getCacheEntries(
    userSession: UserSession,
    db: IDBPDatabase<unknown>,
    type: string,
    max: number | null,
    cacheResults: CacheResults | null,
    shareNames?: string[] | null | undefined): Promise<CacheResults> {
    let ud = userSession.loadUserData();
    let publicKey = getPublicKeyFromPrivate(ud.appPrivateKey);
    let cursor = await db.transaction('cached-indexes').store.index('lastUpdated').openCursor(undefined, "prev");
    if (cursor && cacheResults && cacheResults.nextKey && cacheResults.nextPrimaryKey) {
        cursor = await cursor.continuePrimaryKey(cacheResults.nextKey, cacheResults.nextPrimaryKey)
    }
    let count = 0;
    let cacheEntries: CacheEntry[] = [];
    let nextKey: IDBValidKey | null = null;
    let nextPrimaryKey: IDBValidKey | null = null;
    let shareLookup: any = {};
    if (shareNames && shareNames.length > 0) {
        shareNames.forEach(x => {
            shareLookup[x.toLowerCase()] = true;
        })
    }
    const isMatchCriteria = (cursor: IDBPCursorWithValue<unknown, ["cached-indexes"], "cached-indexes", "lastUpdated"> | null) => {
        if (cursor && cursor.value.data && cursor.value.section === `${publicKey}_${type}`) {
            let canAdd = true;
            let shareName = cursor.value.shareName;
            if (!shareNames && shareName) {
                canAdd = false;
            }
            else if (shareNames && (!shareName || !shareLookup[shareName])) {
                canAdd = false;
            }
            return canAdd;
        }
        return false;
    }
    while (cursor) {
        if (isMatchCriteria(cursor)) {
            cacheEntries.push({
                data: cursor.value.data,
                section: cursor.value.section,
                key: cursor.key,
                primaryKey: cursor.primaryKey,
                lastUpdated: cursor.value.lastUpdated
            });
            count++;
            if (max != null && count >= max) {
                cursor = await cursor.continue();
                while (cursor && !isMatchCriteria(cursor)) {
                    cursor = await cursor.continue();
                }
                if (cursor) {
                    nextKey = cursor.key;
                    nextPrimaryKey = cursor.primaryKey;
                }
                break;
            }
        }
        cursor = await cursor.continue();
    }
    return {
        cacheEntries: cacheEntries,
        nextKey: nextKey,
        nextPrimaryKey: nextPrimaryKey
    };
}

export function getPrivateKeyFileName(
    root: string,
    id: string,
    type: string) {
    let fileName = `${root}${type}/${id}/private.key`;
    return fileName;
}

export async function getPrivateKey(
    root: string,
    userSession: UserSession,
    id: string,
    type: string,
    userName?: string) {
    let privateKeyFile = getPrivateKeyFileName(root, id, type);
    let privateKey: string | null | undefined;
    try {
        if (userName) {
            const encryptedJson = await userSession.getFile(privateKeyFile, {
                decrypt: false,
                verify: false,
                username: userName
            }) as string;
            privateKey = await userSession.decryptContent(encryptedJson) as string;
        }
        else {
            privateKey = await userSession.getFile(privateKeyFile, {
                decrypt: true,
                verify: true,
                username: userName
            }) as string;
        }
    }
    catch {

    }
    return privateKey;
}

export async function getEncryptedFile(
    userSession: UserSession,
    fileName: string,
    id: string,
    type: string,
    owner: string | undefined = undefined) {
    let content: string | ArrayBuffer | undefined = undefined;
    let userData = userSession.loadUserData();
    let userName: string | undefined = undefined;
    if (userData.username !== owner) {
        userName = owner;
    }
    let shareRootInfo = await getShareRootInfo(userData, true, userName);
    let privateKey = await getPrivateKey(shareRootInfo.root, userSession, id, type, userName);
    if (privateKey) {
        let encryptedContent = await userSession.getFile(fileName, {
            decrypt: false,
            username: userName
        }) as string;
        if (encryptedContent) {
            content = await userSession.decryptContent(encryptedContent, {
                privateKey: privateKey
            });
        }
    }
    if (!content) {
        content = await userSession.getFile(fileName);
    }
    return content;
}

export async function createPrivateKey(
    userSession: UserSession,
    id: string,
    type: string) {
    let fileName = getPrivateKeyFileName('', id, type);
    let privateKey = makeECPrivateKey();
    await userSession.putFile(fileName, privateKey, {
        encrypt: true,
        wasString: true,
        sign: true
    })
    return privateKey;
}

export async function getSelectedShares(userSession: UserSession) {
    let selectedShares: string[] = []
    let missingFile = false;
    try {
        let json = await userSession.getFile('selected-shares', {
            decrypt: true,
            verify: true,
        }) as string;
        if (json) {
            selectedShares = JSON.parse(json);
        }
    }
    catch {
        missingFile = true;
    }
    if (missingFile) {
        try {
            await saveSelectedShares(userSession, []);
        }
        catch {

        }
    }
    if (selectedShares.length === 0) {
        return null;
    }
    return selectedShares;
}

export async function saveSelectedShares(userSession: UserSession, selectedShares: string[]) {
    try {
        await userSession.putFile('selected-shares', JSON.stringify(selectedShares), {
            encrypt: true,
            sign: true
        })
    }
    catch (error) {
        console.log(error);
    }
}

export function getShareNames(selectedShares: Array<any> | null | undefined) {
    let shareNames: string[] | undefined = undefined;
    if (selectedShares) {
        const arr: string[] = [];
        selectedShares.forEach(x => {
            if (x?.value) {
                arr.push(x.value);
            }
        })
        if (arr.length > 0) {
            shareNames = arr;
        }
    }
    return shareNames;
}

export async function getShares(userSession: UserSession) {
    let shares: any = {};
    try {
        let json = await userSession?.getFile("share-index", {
            decrypt: true,
            verify: true
        }) as string;
        if (json) {
            shares = JSON.parse(json);
        }
    }
    catch {

    }
    return shares;
}

export async function isFileShared(userSession: UserSession, shareName: string, fileMetaData: FileMetaData) {
    const userData = userSession.loadUserData();
    const rootInfo = await getShareRootInfo(userData, false, shareName);
    const privateKeyFile = getPrivateKeyFileName(rootInfo.root, fileMetaData.id, fileMetaData.type);
    let found = true;
    try {
        await userSession.getFile(privateKeyFile, {
            decrypt: false,
            verify: false
        })
    }
    catch {
        found = false;
    }
    return found;
}

export async function updateShares(userSession: UserSession, userNames: string[], deleteFlag: boolean = false) {
    let shares = await getShares(userSession);
    if (userNames.length > 0) {
        for (let i = 0; i < userNames.length; i++) {
            let userName = userNames[i];
            if (deleteFlag) {
                delete shares[userName.toLowerCase()];
            }
            else {
                shares[userName.toLowerCase()] = userName;
            }
        }
    }
    await userSession.putFile("share-index", JSON.stringify(shares), {
        encrypt: true,
        wasString: true,
        sign: true
    });
}

export async function updateGroup(userSession: UserSession, group: Group, deleteFlag: boolean = false) {
    let groups = await getGroups(userSession);
    if (groups) {
        if (deleteFlag) {
            delete groups[group.id];
        }
        else {
            groups[group.id] = group;
        }
    }
    try {
        await userSession.deleteFile(`groups/${group.id}.index`);
    }
    catch {

    }
    try {
        await userSession.putFile("group-index", JSON.stringify(groups), {
            encrypt: true,
            wasString: true,
            sign: true
        });

    }
    catch {

    }
}

export async function getGroups(userSession: UserSession | null | undefined) {
    let groups: any = {};
    try {
        let json = await userSession?.getFile("group-index", {
            decrypt: true,
            verify: true
        }) as string;
        if (json) {
            groups = JSON.parse(json);
        }
    }
    catch {

    }
    return groups;
}

export async function getSelectedGroup(userSession: UserSession) {
    let selectedGroup: string | null = null;
    let missingFile = false;
    try {
        let text = await userSession.getFile('selected-group', {
            decrypt: true,
            verify: true,
        }) as string;
        if (text && text.length > 0) {
            selectedGroup = text;
        }
    }
    catch {
        missingFile = true;
    }
    if (missingFile) {
        try {
            await saveSelectedGroup(userSession, null);
        }
        catch {

        }
    }
    return selectedGroup;
}

export async function saveSelectedGroup(userSession: UserSession, selectedGroup: string | null) {
    try {
        await userSession.putFile('selected-group', selectedGroup ? selectedGroup : '', {
            encrypt: true,
            sign: true
        })
    }
    catch (error) {
        console.log(error);
    }
}

export async function getGroup(userSession: UserSession, id: string) {
    let group: Group | null = null;
    try {
        let json = await userSession.getFile('group-index', {
            decrypt: true,
            verify: true,
        }) as string;
        if (json && json.length > 0) {
            let map = JSON.parse(json) as any;
            if (map) {
                group = map[id];
            }
        }
    }
    catch {
    }
    return group;
}

export async function getGroupIndex(userSession: UserSession, id: string) {
    let groupIndex = {}
    try {
        let json = await userSession.getFile(`groups/${id}.index`, {
            decrypt: true,
            verify: true
        }) as string;
        if (json) {
            groupIndex = JSON.parse(json);
        }
    }
    catch {

    }
    return groupIndex;
}

export async function saveGroupIndex(userSession: UserSession, id: string, groupIndex: any) {
    try {
        const fileName = `groups/${id}.index`;
        await userSession.putFile(fileName, JSON.stringify(groupIndex), {
            encrypt: true,
            sign: true
        });
    }
    catch (error) {
        console.log(error);
    }
}

export async function addToGroup(fileEntries: FileMetaData[], userSession: UserSession, groupids: string[]) {
    try {
        if (groupids && groupids.length > 0 && fileEntries.length > 0) {
            for (let i = 0; i < groupids.length; i++) {
                const groupIndex = await getGroupIndex(userSession, groupids[i]) as any;
                if (groupIndex) {
                    for (let j = 0; j < fileEntries.length; j++) {
                        const metaData = fileEntries[j];
                        const indexFile = `${metaData.type}/${metaData.id}.index`;
                        groupIndex[indexFile] = metaData.userName;
                    }
                    await saveGroupIndex(userSession, groupids[i], groupIndex);

                }
            }
        }

    }
    catch {

    }
}

export async function removeFromGroup(fileEntries: FileMetaData[], userSession: UserSession, groupid: string) {
    const groupIndex = await getGroupIndex(userSession, groupid) as any;
    if (groupIndex && fileEntries.length > 0) {
        for (let i = 0; i < fileEntries.length; i++) {
            const metaData = fileEntries[i];
            const indexFile = `${metaData.type}/${metaData.id}.index`;
            delete groupIndex[indexFile];
        }
        await saveGroupIndex(userSession, groupid, groupIndex);
    }
}
