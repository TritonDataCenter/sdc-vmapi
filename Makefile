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

#
# Tools
#
NPM		:= npm
TAP		:= ./node_modules/.bin/tap

#
# Files
#
DOC_FILES	 = index.restdown zapi.restdown
JS_FILES	:= $(shell find lib test tools -name '*.js')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE   = server.js $(JS_FILES)
JSSTYLE_FILES	 = server.js $(JS_FILES)
JSSTYLE_FLAGS    = -o indent=2,doxygen,unparenthesized-return=0
SMF_MANIFESTS	 = smf/manifests/zapi.xml

include ./tools/mk/Makefile.defs
include ./tools/mk/Makefile.node.defs
include ./tools/mk/Makefile.smf.defs

ROOT            := $(shell pwd)
RELEASE_TARBALL := zapi-pkg-$(STAMP).tar.bz2
TMPDIR          := /tmp/$(STAMP)


#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(TAP)
	$(NPM) rebuild

$(TAP): | $(NPM_EXEC)
	$(NPM) install

  (test -d node_modules/sdc-clients || \
	git clone git@git.joyent.com:node-sdc-clients.git node_modules/sdc-clients)
	(cd node_modules/sdc-clients && $(NPM) install)
  (test -d node_modules/amqp || \
  git clone https://github.com/postwait/node-amqp.git node_modules/amqp)

CLEAN_FILES += $(TAP) ./node_modules/tap


.PHONY: release
release: all deps docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(TMPDIR)/root/opt/smartdc/zapi
	@mkdir -p $(TMPDIR)/site
	@touch $(TMPDIR)/site/.do-not-delete-me
	cp -r   $(ROOT)/build \
    $(ROOT)/lib \
    $(ROOT)/server.js \
    $(ROOT)/Makefile \
    $(ROOT)/node_modules \
    $(ROOT)/package.json \
    $(ROOT)/smf \
    $(ROOT)/tools \
    $(TMPDIR)/root/opt/smartdc/zapi/
	(cd $(TMPDIR) && $(TAR) -jcf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(TMPDIR)


.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
    echo "error: 'BITS_DIR' must be set for 'publish' target"; \
    exit 1; \
  fi
	mkdir -p $(BITS_DIR)/zapi
	cp $(ROOT)/$(RELEASE_TARBALL) $(BITS_DIR)/zapi/$(RELEASE_TARBALL)


.PHONY: test
test: $(TAP)
	TAP=1 $(TAP) test/*.test.js


include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.node.targ
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ
