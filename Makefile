#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
#
# Makefile: basic Makefile for template API service
#
# This Makefile is a template for new repos. It contains only repo-specific
# logic and uses included makefiles to supply common targets (javascriptlint,
# jsstyle, restdown, etc.), which are used by other repos as well. You may well
# need to rewrite most of this file, but you shouldn't need to touch the
# included makefiles.
#
# If you find yourself adding support for new targets that could be useful for
# other projects too, you should add these to the original versions of the
# included Makefiles (in eng.git) so that other teams can use them too.
#

# The prebuilt sdcnode version we want. See
# "tools/mk/Makefile.node_prebuilt.targ" for details.
NODE_PREBUILT_VERSION=v0.8.22
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_TAG=zone
	# Allow building on a SmartOS image other than smartos-1.6.3.
	NODE_PREBUILT_IMAGE=01b2c898-945f-11e1-a523-af1afbe22822
endif

#
# Tools
#
NPM		:= npm
NODEUNIT  := ./node_modules/.bin/nodeunit

#
# Files
#
DOC_FILES	 = index.restdown
JS_FILES	:= $(shell find lib test -name '*.js')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE   = server.js $(JS_FILES)
JSSTYLE_FILES	 = server.js $(JS_FILES)
JSSTYLE_FLAGS    = -o indent=4,doxygen,unparenthesized-return=0
SMF_MANIFESTS_IN	 = smf/manifests/vmapi.xml.in

include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	include ./tools/mk/Makefile.node.defs
endif
include ./tools/mk/Makefile.node_deps.defs
include ./tools/mk/Makefile.smf.defs

ROOT            := $(shell pwd)
RELEASE_TARBALL := vmapi-pkg-$(STAMP).tar.bz2
RELSTAGEDIR          := /tmp/$(STAMP)


#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NODEUNIT) $(REPO_DEPS) sdc-scripts
	$(NPM) rebuild

$(NODEUNIT): | $(NPM_EXEC)
	$(NPM) install

CLEAN_FILES += $(NODEUNIT) ./node_modules/nodeunit


.PHONY: release
release: all deps docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/vmapi/build
	@mkdir -p $(RELSTAGEDIR)/site
	@touch $(RELSTAGEDIR)/site/.do-not-delete-me
	cp -PR $(NODE_INSTALL) $(RELSTAGEDIR)/root/opt/smartdc/vmapi/build/node
	cp -r $(ROOT)/lib \
	$(ROOT)/bin \
    $(ROOT)/server.js \
    $(ROOT)/Makefile \
    $(ROOT)/node_modules \
    $(ROOT)/package.json \
    $(ROOT)/config.json.in \
    $(ROOT)/sapi_manifests \
    $(ROOT)/smf \
    $(ROOT)/test \
    $(ROOT)/tools \
    $(RELSTAGEDIR)/root/opt/smartdc/vmapi/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(ROOT)/deps/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R $(ROOT)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	(cd $(RELSTAGEDIR) && $(TAR) -jcf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)


.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
    echo "error: 'BITS_DIR' must be set for 'publish' target"; \
    exit 1; \
  fi
	mkdir -p $(BITS_DIR)/vmapi
	cp $(ROOT)/$(RELEASE_TARBALL) $(BITS_DIR)/vmapi/$(RELEASE_TARBALL)


.PHONY: test
test: $(NODEUNIT)
	$(NODEUNIT) test/vms.test.js


include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
else
	include ./tools/mk/Makefile.node.targ
endif
include ./tools/mk/Makefile.node_deps.targ
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ

sdc-scripts: deps/sdc-scripts/.git
