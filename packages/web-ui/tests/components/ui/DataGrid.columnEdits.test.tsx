import {act, fireEvent, render} from '@testing-library/react';
import type {ComponentProps} from 'react';
import {vi} from 'vitest';
import {DataGrid} from '@/components/ui/DataGrid';
import type {TableColumn} from '@/types/editor';
import type {ColumnSource} from '@/types/plugins';
import {
    pendingChangeKey,
    resolveColumnEdits,
    sourceTableKey,
    type SourceTableMeta,
} from '@/utils/columnSources';

// Per-column editing of a joined result (#690). Mocks mirror DataGrid.test.tsx.

vi.mock('lucide-react', async (importOriginal) => await importOriginal());

vi.mock('@/hooks/useDatabase', () => ({
    useDatabase: () => ({activeSchema: null, connections: [], getConnectionData: vi.fn()}),
}));

const {showAlertMock} = vi.hoisted(() => ({showAlertMock: vi.fn()}));

vi.mock('@/hooks/useAlert', () => ({
    useAlert: () => ({showAlert: showAlertMock}),
}));

vi.mock('@/hooks/useTabularisClient', () => ({
    useTabularisClient: () => ({call: vi.fn()}),
}));

const {showToastMock, downloadFileMock, readClipboardMock, translate} = vi.hoisted(() => ({
    showToastMock: vi.fn(),
    downloadFileMock: vi.fn(),
    readClipboardMock: vi.fn(),
    // Stable like react-i18next's own `t`: the grid's column definitions depend on it.
    // Keys come back as they are, with the count when there is one.
    translate: (key: string, options?: {count?: number}) =>
        options?.count === undefined ? key : `${key}:${options.count}`,
}));

vi.mock('@/hooks/usePlatformCapabilities', () => ({
    usePlatformCapabilities: () => ({
        writeClipboardHtml: vi.fn(),
        downloadFile: downloadFileMock,
        readClipboard: readClipboardMock,
    }),
}));

vi.mock('@/platform/secondaryWindowSessions', () => ({
    getJsonViewerSessionHost: () => ({open: vi.fn()}),
}));

vi.mock('@/hooks/useToast', () => ({
    useToast: () => ({showToast: showToastMock}),
}));

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: translate,
        i18n: {language: 'en', changeLanguage: vi.fn()},
    }),
    initReactI18next: {type: '3rdParty', init: vi.fn()},
}));

vi.mock('@/hooks/useSettings', () => ({
    useSettings: () => ({settings: {}}),
}));

vi.mock('@/hooks/useRightSidebar', () => ({
    useRightSidebar: () => ({
        isOpen: false,
        activePanel: null,
        rowEditorData: null,
        isPinned: false,
        openRowEditor: vi.fn(),
        updateRowEditorData: vi.fn(),
        close: vi.fn(),
        toggle: vi.fn(),
        setActivePanel: vi.fn(),
        togglePin: vi.fn(),
        onChangeRef: {current: null},
    }),
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn().mockResolvedValue(vi.fn()),
}));

// JSDOM has no layout: render every row.
vi.mock('@tanstack/react-virtual', () => ({
    useVirtualizer: ({count}: {count: number}) => {
        const items = Array.from({length: count}, (_, index) => ({
            index,
            key: index,
            start: index * 35,
            end: (index + 1) * 35,
            size: 35,
        }));
        return {
            getVirtualItems: () => items,
            getTotalSize: () => count * 35,
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
    },
}));

vi.stubGlobal(
    'ResizeObserver',
    class {
        observe() {}
        unobserve() {}
        disconnect() {}
    },
);

const col = (name: string, is_pk = false): TableColumn => ({
    name,
    data_type: 'text',
    is_pk,
    is_nullable: true,
    is_auto_increment: false,
});
const tables: Record<string, SourceTableMeta> = {
    [sourceTableKey({table: 'orders'})]: {
        columns: [col('id', true), col('total')],
        isView: false,
    },
    [sourceTableKey({table: 'customers'})]: {
        columns: [col('id', true), col('name')],
        isView: false,
    },
};

// SELECT o.id AS order_id, o.total, c.id AS customer_id, c.name
// FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
const columns = ['order_id', 'total', 'customer_id', 'name'];
const sources: Array<ColumnSource | null> = [
    {table: 'orders', column: 'id'},
    {table: 'orders', column: 'total'},
    {table: 'customers', column: 'id'},
    {table: 'customers', column: 'name'},
];
const data: unknown[][] = [
    [10, 99.5, 3, 'Ada'],
    [11, 12, 3, 'Ada'], // same customer again (1:N)
    [12, 5, null, null], // no customer (LEFT JOIN)
];
const columnEdits = resolveColumnEdits(columns, sources, tables);
const customer3 = pendingChangeKey({table: 'customers'}, {id: 3});

const cellAt = (container: HTMLElement, rowIndex: number, colIndex: number) =>
    container.querySelector(`tr[data-row-index="${rowIndex}"] td[data-col-index="${colIndex}"]`)!;

const headerOf = (container: HTMLElement, colIndex: number) =>
    container.querySelector(`th[data-col-index="${colIndex}"]`)!;

function renderGrid(props: Partial<ComponentProps<typeof DataGrid>> = {}) {
    return render(
        <DataGrid
            columns={columns}
            data={data}
            tableName={null}
            pkColumns={null}
            columnEdits={columnEdits}
            selectedRows={new Set()}
            onSelectionChange={vi.fn()}
            onPendingChange={vi.fn()}
            {...props}
        />,
    );
}

describe('DataGrid joined result editing (#690)', () => {
    beforeEach(() => {
        showAlertMock.mockClear();
    });

    describe('column headers', () => {
        it('give every column a keyboard-focusable button with its reason as the accessible name', () => {
            const {container} = renderGrid();
            const labelOf = (index: number) =>
                headerOf(container, index).querySelector('button[data-column-edit]');

            const key = labelOf(0)!;
            expect(key.getAttribute('data-column-edit')).toBe('readonly');
            expect(key.getAttribute('aria-label')).toBe('dataGrid.sourceEdit.reason.primaryKey');
            expect(key.tagName).toBe('BUTTON');
            expect(key.getAttribute('title')).toBe(key.getAttribute('aria-label'));
            // the icon itself is hidden from screen readers; the button carries the text
            expect(key.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

            const total = labelOf(1)!;
            expect(total.getAttribute('data-column-edit')).toBe('editable');
            expect(total.getAttribute('aria-label')).toBe('dataGrid.sourceEdit.editable');
        });

        it('say why a column is read-only for each reason', () => {
            const reasons = resolveColumnEdits(
                ['a', 'b', 'c', 'd'],
                [
                    null,
                    {table: 'v', column: 'x'},
                    {table: 'customers', column: 'name'},
                    {table: 'customers', column: 'name'},
                ],
                {...tables, [sourceTableKey({table: 'v'})]: {columns: [], isView: true}},
            );
            const {container} = render(
                <DataGrid
                    columns={['a', 'b', 'c', 'd']}
                    data={[[1, 2, 3, 4]]}
                    tableName={null}
                    columnEdits={reasons}
                    selectedRows={new Set()}
                    onSelectionChange={vi.fn()}
                />,
            );
            const labels = [0, 1, 2, 3].map((i) =>
                headerOf(container, i).querySelector('button')?.getAttribute('aria-label'),
            );
            expect(labels).toEqual([
                'dataGrid.sourceEdit.reason.computed',
                'dataGrid.sourceEdit.reason.view',
                'dataGrid.sourceEdit.reason.ambiguous',
                'dataGrid.sourceEdit.reason.ambiguous',
            ]);
        });

        it('has no icons for a grid without columnEdits', () => {
            const {container} = renderGrid({columnEdits: undefined});
            expect(container.querySelector('button[data-column-edit]')).toBeNull();
        });
    });

    describe('editing', () => {
        async function typeInto(
            container: HTMLElement,
            row: number,
            colIndex: number,
            value: string,
        ) {
            fireEvent.doubleClick(cellAt(container, row, colIndex));
            const editor = container.querySelector('textarea')!;
            fireEvent.change(editor, {target: {value}});
            fireEvent.keyDown(editor, {key: 'Enter'});
            await act(async () => {});
        }

        it('stages a cell through its own source table and key', async () => {
            const onPendingChange = vi.fn();
            const {container} = renderGrid({onPendingChange});

            await typeInto(container, 0, 1, '7');
            expect(onPendingChange).toHaveBeenLastCalledWith({id: 10}, 'total', '7', {
                table: 'orders',
                key: pendingChangeKey({table: 'orders'}, {id: 10}),
            });

            await typeInto(container, 0, 3, 'Grace');
            expect(onPendingChange).toHaveBeenLastCalledWith({id: 3}, 'name', 'Grace', {
                table: 'customers',
                key: customer3,
            });
        });

        it('explains a read-only column instead of opening the editor', () => {
            const {container} = renderGrid();
            fireEvent.doubleClick(cellAt(container, 0, 0));
            expect(container.querySelector('textarea')).toBeNull();
            expect(showAlertMock).toHaveBeenCalledWith(
                'dataGrid.sourceEdit.reason.primaryKey',
                expect.objectContaining({kind: 'warning'}),
            );
        });

        it('keeps the cells of the empty side of a LEFT JOIN read-only, not the other table', () => {
            const {container} = renderGrid();
            fireEvent.doubleClick(cellAt(container, 2, 3));
            expect(container.querySelector('textarea')).toBeNull();
            expect(showAlertMock).toHaveBeenCalledWith(
                'dataGrid.sourceEdit.reason.nullKey',
                expect.objectContaining({kind: 'warning'}),
            );

            fireEvent.doubleClick(cellAt(container, 2, 1));
            expect(container.querySelector('textarea')).not.toBeNull();
        });

        it('shows a pending edit on every copy of the target row (1:N)', () => {
            const {container} = renderGrid({
                pendingChanges: {
                    [customer3]: {
                        pkOriginalValue: {id: 3},
                        changes: {name: 'Grace'},
                        target: {table: 'customers'},
                    },
                },
            });
            expect(cellAt(container, 0, 3).textContent).toContain('Grace');
            expect(cellAt(container, 1, 3).textContent).toContain('Grace');
            // another table's column and the NULL row are untouched
            expect(cellAt(container, 0, 1).textContent).toContain('99.5');
            expect(cellAt(container, 2, 3).textContent).not.toContain('Grace');
        });
    });

    describe('self-join without table_alias (ambiguous)', () => {
        it('locks every column of the repeated table, with the ambiguous reason', () => {
            // PostgreSQL / SQLite: SELECT a.id, a.name, b.name FROM customers a JOIN customers b ...
            const selfJoin = resolveColumnEdits(
                ['id', 'name', 'name'],
                [
                    {table: 'customers', column: 'id'},
                    {table: 'customers', column: 'name'},
                    {table: 'customers', column: 'name'},
                ],
                tables,
            );
            const {container} = render(
                <DataGrid
                    columns={['id', 'name', 'name']}
                    data={[[1, 'Ada', 'Grace']]}
                    tableName={null}
                    columnEdits={selfJoin}
                    selectedRows={new Set()}
                    onSelectionChange={vi.fn()}
                    onPendingChange={vi.fn()}
                />,
            );
            fireEvent.doubleClick(cellAt(container, 0, 1));
            expect(container.querySelector('textarea')).toBeNull();
            expect(showAlertMock).toHaveBeenCalledWith(
                'dataGrid.sourceEdit.reason.ambiguous',
                expect.anything(),
            );
        });
    });
});
