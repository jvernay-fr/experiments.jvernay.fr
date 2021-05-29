/* By Julien Vernay ( jvernay.fr ). Under GNU AGPL v3. */
// Responsible for creating and displaying a popup to the user.




class jvPopup {

    // Creates a child of <body> containing a form, and mimics a popup.
    // The given element must be a <form>.
    // The popup will not be visible, you must call the display() method.
    constructor(formElement, styleBG = {}, styleFG = {}) {

        this._popupBG = document.createElement("div");
        Object.assign(this._popupBG.style, jvPopup.STYLES.popupBG);
        Object.assign(this._popupBG.style, styleBG);

        this._popup = document.createElement("div");
        Object.assign(this._popup.style, jvPopup.STYLES.popup);
        Object.assign(this._popup.style, styleFG);

        document.getElementsByTagName("body")[0].appendChild(this._popupBG);
        this._popupBG.appendChild(this._popup);
        this._formPreviousParent = formElement.parentNode;
        this._popup.appendChild(formElement);
        this._form = formElement;
        
        this._popupBG.style.display = "none";
    }

    // Displays the popup and returns a promised which will be fulfilled when the form is submitted.
    // 'then' can be one of:
    // - "destroy": destroy() will be called after submission
    // - "hide": hide() will be called, the popup will not be destroyed
    // - other: neither destroy() nor hide() will be called.
    // The promise returns a FormData when resolved.
    async display(then = "destroy") {
        return await new Promise((resolve,reject) => {
            this._form.addEventListener("submit", event => {
                event.preventDefault();
                if (then === "hide") this.hide();
                if (then === "destroy") this.destroy();
                resolve(new FormData(this._form));
            }, {once: true});
            this._popupBG.style.display = "flex";
        });
    }

    // Hides the popup.
    hide() {
        this._popupBG.style.display = "none";
    }

    // Destroys the popup, removing from the DOM.
    destroy() {
        if (this._formPreviousParent)
            this._formPreviousParent.appendChild(this._form);
        document.getElementsByTagName("body")[0].removeChild(this._popupBG);
    }

}

jvPopup.STYLES = {
    popupBG: {
        zIndex: "1",
        position: "fixed",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
        backgroundColor: "rgba(50, 50, 100, 0.6)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
    },
    popup: {
        backgroundColor: "rgba(255, 255, 255, 1)",
        border: "2px solid black",
        padding: "0 1em",
    },
};