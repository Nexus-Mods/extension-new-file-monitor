import { NAMESPACE } from './globals';

import * as path from 'path';
import turbowalk, { IEntry } from 'turbowalk';
import { fs, log, selectors, types, util } from 'vortex-api';

interface IDeployment {
  [typeId: string]: types.IDeployedFile[];
}

interface ITree {
  owners: Set<string>;
  directories: { [name: string]: ITree };
  files: { [name: string]: types.IDeployedFile };
}

function addToTree(tree: ITree,
                   filePath: string,
                   entry?: types.IDeployedFile): ITree {
  if (entry !== undefined) {
    tree.owners.add(entry.source);
  }
  filePath.split(path.sep).forEach((iter: string, idx: number, arr: string[]) => {
    if ((idx === arr.length - 1) && (entry !== undefined)) {
        tree.files[iter] = entry;
    } else {
      if (tree.directories[iter] === undefined) {
        tree.directories[iter] = {
          owners: new Set<string>([]),
          directories: {},
          files: {},
        };
      }
      tree = tree.directories[iter];
      if (entry !== undefined) {
        tree.owners.add(entry.source);
      }
    }
  });

  return tree;
}

function getTree(tree: ITree, dirPath: string, required: boolean): ITree {
  const segments = dirPath.split(path.sep);
  for (const seg of segments) {
    const nextTree = tree.directories[seg];
    if (nextTree === undefined) {
      if (required) {
        return undefined;
      } else {
        return tree;
      }
    }
    tree = nextTree;
  }
  return tree;
}

function getFileList(basePath: string, tree: ITree): string[] {
  return [].concat(
    Object.keys(tree.files).map(fileName => path.join(basePath, fileName)),
    ...Object.keys(tree.directories).map(dirName =>
      getFileList(path.join(basePath, dirName), tree.directories[dirName])));
}

async function snapshot(basePath: string, deployment: ITree): Promise<string[]> {
  const tree = getTree(deployment, basePath, true);
  const deploymentSet = new Set<string>(getFileList(basePath, tree));

  let vanillaFiles: string[] = [];
  await turbowalk(basePath, (entries: IEntry[]) => {
    vanillaFiles = [].concat(vanillaFiles,
      entries
        .filter(entry => !entry.isDirectory && !deploymentSet.has(entry.filePath))
        .map(entry => path.relative(basePath, entry.filePath)));
  }, { recurse: true, details: false, skipLinks: true });

  // I _think_ we have to sort here because the api doesn't promise a specific file
  // order, even though it's usually going to be alphabetical.
  return vanillaFiles.sort((lhs, rhs) => lhs.localeCompare(rhs));
}

async function saveSnapshot(filePath: string, data: any) {
  await fs.ensureDirWritableAsync(path.dirname(filePath));
  await fs.writeFileAsync(filePath, JSON.stringify(data, undefined, 2), { encoding: 'utf-8' });
}

function compareEntries(normalize: (input: string) => string, before: string[], after: string[]) {
  const normCompare = (lhs, rhs) => normalize(lhs).localeCompare(normalize(rhs));

  // we could be using _.differenceWith here but I think we can get better performance using the
  // knowledge that the lists are already sorted

  const added: string[] = [];
  const removed: string[] = [];

  let beforeIdx = 0;
  let afterIdx = 0;
  const beforeLength = before.length;
  const afterLength = after.length;

  while ((beforeIdx < beforeLength) && (afterIdx < afterLength)) {
    const comp = normCompare(before[beforeIdx], after[afterIdx]);
    if (comp === 0) {
      ++beforeIdx;
      ++afterIdx;
    } else if (comp < 0) {
      // name in the before-list is "smaller", meaning it doesn't exist in the after list
      removed.push(before[beforeIdx++]);
    } else {
      // name in the after-list is smaller, meaning it doesn't exist in the before list
      added.push(after[afterIdx++]);
    }
  }

  while (beforeIdx < beforeLength) {
    removed.push(before[beforeIdx++]);
  }

  while (afterIdx < afterLength) {
    after.push(after[afterIdx++]);
  }

  return {
    added,
    removed,
  };
}

async function consolidate(deployment: IDeployment,
                           modPaths: { [typeId: string]: string }): Promise<ITree> {
  const tree: ITree = {
    owners: new Set<string>([]),
    directories: {},
    files: {},
  };

  await Promise.all(Object.keys(modPaths).map(async modType => {
    const modTypeTree = addToTree(tree, modPaths[modType]);
    deployment[modType].forEach(deployed => {
      addToTree(modTypeTree, deployed.relPath, deployed);
    });
  }));

  return tree;
}

function figureOutBasePaths(tree: ITree): string[] {
  const bases: string[] = [];

  // current logic: base paths is every directory that has more than one subdirectory
  // or contains files

  const getBase = (current: ITree, basePath: string[]): string => {
    if ((Object.keys(current.files).length > 0)
        || (Object.keys(current.directories).length !== 1)) {
      return basePath.join(path.sep);
    }

    const dirName = Object.keys(current.directories)[0];
    return getBase(current.directories[dirName], [].concat(basePath, dirName));
  };

  Object.keys(tree.directories).forEach(dirName => {
    const base = getBase(tree.directories[dirName], [dirName]);
    bases.push(base);
  });

  return bases;
}

function makeOnWillDeploy(api: types.IExtensionApi) {
  return async (profileId: string,
                deployment: IDeployment) => {
    const state: types.IState = api.store.getState();
    const profile = selectors.profileById(state, profileId);

    const game = util.getGame(profile.gameId);
    const discovery = selectors.discoveryByGame(state, game.id);

    const modPaths = game.getModPaths(discovery.path);

    const snapshotPath =
      path.join(util.getVortexPath('userData' as any), game.id, 'snapshots', 'snapshot.json');

    const fullDeployment = await consolidate(deployment, modPaths);

    const basePaths = figureOutBasePaths(fullDeployment);

    const roots = [];

    try {
      const oldSnapshot = JSON.parse(await fs.readFileAsync(snapshotPath, { encoding: 'utf-8' }));

      await Promise.all(basePaths.map(async basePath => {
        const oldEntries = oldSnapshot.find(iter => iter.basePath === basePath);
        const entries = await snapshot(basePath, fullDeployment);

        if (oldEntries === undefined) {
          log('info', 'no old entries for path', { basePath });
        } else {
          const normalize = await util.getNormalizeFunc(basePath,
            { relative: false, separators: false, unicode: false });
          const { added, removed } = compareEntries(normalize, oldEntries.entries, entries);
          const normTree = (util as any).makeNormalizingDict(fullDeployment, normalize);
          const baseTree = getTree(normTree, basePath, true);
          if (added.length > 0) {
            await api.emitAndAwait('added-files', profileId, added.map(filePath => {
              const treeEntry = getTree(baseTree, path.dirname(filePath), false);
              return {
                filePath: path.join(basePath, filePath),
                candidates: Array.from(treeEntry.owners),
              };
            }));
          }
          if (removed.length > 0) {
            await api.emitAndAwait('removed-files', profileId, removed.map(filePath => {
              const treeEntry = getTree(baseTree, path.dirname(filePath), false);
              return {
                filePath: path.join(basePath, filePath),
                candidates: Array.from(treeEntry.owners),
              };
            }));
          }
        }

        roots.push({ basePath, entries });
      }));

      await saveSnapshot(snapshotPath, roots);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        api.showErrorNotification('Failed to check for added files', err);
      }
    }
  };
}

function makeOnDidDeploy(api: types.IExtensionApi) {
  const t = api.translate;

  return async (profileId: string,
                deployment: IDeployment,
                setTitle: (title: string) => void) => {
    setTitle(t('Creating snapshots', { ns: NAMESPACE }));

    const state: types.IState = api.store.getState();
    const profile = selectors.profileById(state, profileId);

    const game = util.getGame(profile.gameId);
    const discovery = selectors.discoveryByGame(state, game.id);

    const modPaths = game.getModPaths(discovery.path);

    const snapshotPath = path.join(util.getVortexPath('userData' as any), game.id,
                                   'snapshots', 'snapshot.json');

    const fullDeployment = await consolidate(deployment, modPaths);
    const basePaths = figureOutBasePaths(fullDeployment);

    const roots = [];

    await Promise.all(basePaths.map(async basePath => {
      const entries = await snapshot(basePath, fullDeployment);
      roots.push({ basePath, entries });
    }));
    await saveSnapshot(snapshotPath, roots);
  };
}

function init(context: types.IExtensionContext): boolean {
  context.once(() => {
    context.api.onAsync('will-deploy', makeOnWillDeploy(context.api) as any);
    context.api.onAsync('did-deploy', makeOnDidDeploy(context.api) as any);
  });

  return true;
}

export default init;
