/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RStudio, PBC.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./modalDialog';
import * as DOM from 'vs/base/browser/dom';
import { Disposable } from 'vs/base/common/lifecycle';

/**
 * ModalDialog class.
 */
export class ModalDialog extends Disposable {
	//#region Private Member Variables

	private readonly element: HTMLElement;
	private readonly shadowElement: HTMLElement;
	private modalElement: HTMLElement | undefined;

	//#endregion Private Member Variables

	//#region Class Initialization

	/**
	 * Initializes a new instance of the ModalDialog class.
	 * @param container The HTMLElement that contains the ModalDialog.
	 */
	constructor(private container: HTMLElement) {
		super();

		this.modalElement = this.container.appendChild(DOM.$(`.monaco-modal-dialog-modal-block.dimmed`));
		this.shadowElement = this.modalElement.appendChild(DOM.$('.modal-dialog-shadow'));

		this.element = this.shadowElement.appendChild(DOM.$('.monaco-modal-dialog-box'));
		this.element.setAttribute('role', 'dialog');
		this.element.tabIndex = -1;

		const content = this.element.appendChild(DOM.$('.monaco-modal-dialog-box-content'));
		content.innerText = 'This is a modal dialog box.';

		DOM.hide(this.element);
	}

	async show(): Promise<void> {
		//const focusToReturn = document.activeElement as HTMLElement;

		DOM.show(this.element);
	}

	//#endregion Class Initialization
}

