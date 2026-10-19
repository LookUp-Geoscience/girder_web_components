import { computed, inject, isRef, ref, toRef, watch } from 'vue';
import {
  formatSize,
  getLocationType,
  getResourceIcon,
  getSingularLocationTypeName,
} from '@/utils';

const GIRDER_FOLDER_ENDPOINT = 'folder';
const GIRDER_ITEM_ENDPOINT = 'item';

function emptyCounts() {
  return {
    nFolders: 0,
    nItems: 0,
    nUsers: 0,
    nCollections: 0,
  };
}

/**
 * Headless state and data fetching for browsing a Girder hierarchy.
 *
 * It holds no rendering logic: it exposes the rows of the current location,
 * the pagination state and the loading state, so that any UI can render them.
 *
 * @param {Object} params
 * @param {import('vue').MaybeRefOrGetter<Object>} params.location
 *   Current location: a folder, user or collection model, or a root location
 *   such as `{ type: 'root' }`, `{ type: 'collections' }` or `{ type: 'users' }`.
 * @param {import('vue').Ref<{ page: number, itemsPerPage: number }>} [params.options]
 *   Pagination options. `itemsPerPage: -1` means all rows. A ref is created when omitted.
 * @param {import('@/utils/restClient').default} [params.rest]
 *   Girder REST client. Defaults to the client provided by the plugin.
 * @param {import('vue').Ref<Object|null>} [params.user]
 *   Current user. Defaults to the user provided by the plugin. Data is
 *   refetched when it changes.
 */
export default function useDataBrowser({
  location,
  options,
  rest,
  user,
} = {}) {
  const injected = rest && user ? null : inject('girder', null);
  const client = rest || injected?.rest;
  if (!client) {
    throw new Error('useDataBrowser: no Girder REST client was provided or injected');
  }
  const currentUser = user || injected?.user || ref(null);

  const locationRef = toRef(location);
  const optionsRef = isRef(options)
    ? options
    : ref(options || { page: 1, itemsPerPage: 10 });

  // ---- State ----
  const refreshCounter = ref(0);
  const rows = ref([]);
  const loading = ref(false);
  const error = ref(null);
  const counts = ref(emptyCounts());
  let lastRequest = 0;

  // ---- Computed ----
  const serverItemsLength = computed(() =>
    Object.values(counts.value).reduce((a, b) => a + b, 0),
  );

  // ---- Fetching ----
  async function fetchPaginatedFolderRows() {
    const { nFolders, nItems } = counts.value;
    const { page, itemsPerPage } = optionsRef.value;
    const currentLocation = locationRef.value;

    let folderNotPublic = false;
    if (!currentLocation.created && currentLocation._modelType === 'folder') {
      folderNotPublic = !(await client.get(`folder/${currentLocation._id}`)).data
        .public;
    }

    const promises = [];

    const folderOffset = itemsPerPage === -1 ? 0 : (page - 1) * itemsPerPage;

    const foldersLeft = Math.max(nFolders - folderOffset, 0);
    if (foldersLeft > 0) {
      promises.push(
        client.get(GIRDER_FOLDER_ENDPOINT, {
          params: {
            parentType: currentLocation._modelType,
            parentId: currentLocation._id,
            limit: itemsPerPage === -1 ? 0 : itemsPerPage,
            offset: folderOffset,
          },
        }),
      );
    }

    const itemOffset = Math.max(folderOffset - nFolders, 0);
    const itemsLeft = Math.max(nItems - itemOffset, 0);

    if (itemsLeft > 0 && (itemsPerPage === -1 || itemsPerPage - foldersLeft > 0)) {
      promises.push(
        client.get(GIRDER_ITEM_ENDPOINT, {
          params: {
            folderId: currentLocation._id,
            limit: itemsPerPage === -1 ? 0 : itemsPerPage - foldersLeft,
            offset: itemOffset,
          },
        }),
      );
    }

    return (await Promise.all(promises))
      .flatMap((r) => r.data)
      .map((item) => ({
        ...item,
        humanSize: item.size ? formatSize(item.size) : '',
        icon: getResourceIcon(item),
        notPublic: item._modelType === 'folder' ? !item.public : folderNotPublic,
      }));
  }

  async function fetchPaginatedCollectionOrUserRows(type) {
    const { page, itemsPerPage } = optionsRef.value;
    const { data } = await client.get(type, {
      params: {
        limit: itemsPerPage >= 0 ? itemsPerPage : null,
        offset: (page - 1) * itemsPerPage,
      },
    });

    return data.map((item) => ({
      ...item,
      name:
        item._modelType === 'user'
          ? `${item.firstName} ${item.lastName}`
          : item.name,
      humanSize: item.size ? formatSize(item.size) : '',
      icon: getResourceIcon(item),
    }));
  }

  function generateRootRows() {
    const rootRows = [{ type: 'collections', name: 'Collections', icon: '$collection' }];
    if (client.user) {
      rootRows.push({ type: 'users', name: 'Users', icon: '$user' });
    }
    return rootRows;
  }

  async function fetchPaginatedRows() {
    if (counts.value.nFolders || counts.value.nItems) {
      return fetchPaginatedFolderRows();
    }

    const type = getLocationType(locationRef.value);
    if (['users', 'collections'].includes(type)) {
      return fetchPaginatedCollectionOrUserRows(
        getSingularLocationTypeName(locationRef.value),
      );
    }

    if (type === 'root') {
      return generateRootRows();
    }

    return [];
  }

  async function fetchCounts() {
    const base = emptyCounts();
    const type = getLocationType(locationRef.value);
    const { _id } = locationRef.value;

    try {
      if (['folder', 'user', 'collection'].includes(type)) {
        const { data } = await client.get(`${type}/${_id}/details`);
        counts.value = {
          ...base,
          nFolders: data.nFolders || 0,
          nItems: data.nItems || 0,
        };
        return;
      }

      if (type === 'users' || type === 'collections') {
        const { data } = await client.get(
          `${getSingularLocationTypeName(locationRef.value)}/details`,
        );
        const key = Object.keys(data)[0];
        counts.value = { ...base, [key]: Object.values(data)[0] };
        return;
      }

      if (type === 'root') {
        counts.value = { ...base, nUsers: 1, nCollections: 1 };
        return;
      }

      counts.value = base;
    } catch (_err) {
      counts.value = base;
    }
  }

  async function updateRows() {
    // Responses of outdated requests are ignored, so that a slow response
    // for a previous location or page cannot overwrite the current rows.
    const request = ++lastRequest;
    loading.value = true;
    error.value = null;
    try {
      const result = await fetchPaginatedRows();
      if (request === lastRequest) {
        rows.value = result;
      }
    } catch (err) {
      if (request === lastRequest) {
        error.value = err;
      }
    } finally {
      if (request === lastRequest) {
        loading.value = false;
      }
    }
  }

  // ---- Methods ----
  function refresh() {
    refreshCounter.value++;
  }

  // ---- Watchers ----
  watch([refreshCounter, locationRef, currentUser], fetchCounts, { immediate: true });

  watch(locationRef, (newLocation) => {
    if (newLocation && optionsRef.value) {
      optionsRef.value.page = 1;
    }
  });

  watch([counts, optionsRef], updateRows);

  return {
    rows,
    loading,
    error,
    counts,
    serverItemsLength,
    options: optionsRef,
    refresh,
  };
}
