import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {tabNavigationIndex} from '../src/renderer/behavior.ts';

test('shell polish keeps inset focus, non-color selected tabs and coarse input target sizes',()=>{
 const css=readFileSync(new URL('../src/renderer/aside-shell.css',import.meta.url),'utf8');
 assert.match(css,/\.sidebar-tab[^{}]*:focus-visible\s*\{[^}]*outline-offset:\s*-2px/);
 assert.match(css,/\[aria-selected="true"\]\s*\{[^}]*font-weight:\s*600/);
 assert.match(css,/@media\s*\(pointer:\s*coarse\)[\s\S]*min-height:\s*44px/);
 assert.match(css,/\.home-input-hint\s*\{[^}]*font-size:\s*11px/);
});

test('tab keyboard navigation respects orientation, wraps, and supports Home/End without claiming other keys',()=>{
 assert.equal(tabNavigationIndex('ArrowDown',0,3,'vertical'),1);
 assert.equal(tabNavigationIndex('ArrowUp',0,3,'vertical'),2);
 assert.equal(tabNavigationIndex('ArrowRight',0,3,'vertical'),null);
 assert.equal(tabNavigationIndex('ArrowRight',2,3,'horizontal'),0);
 assert.equal(tabNavigationIndex('ArrowLeft',0,3,'horizontal'),2);
 assert.equal(tabNavigationIndex('Home',2,3,'vertical'),0);
 assert.equal(tabNavigationIndex('End',0,3,'horizontal'),2);
 assert.equal(tabNavigationIndex('Escape',0,3,'horizontal'),null);
 assert.equal(tabNavigationIndex('ArrowDown',0,0,'vertical'),null);
});
